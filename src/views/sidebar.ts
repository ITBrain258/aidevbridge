// Seitenleiste: Baum aus Hosts und ihren Sessions -- das zentrale
// Navigationselement der Oberflaeche. "Entwurf §n" verweist auf den
// Seitenleistenentwurf vom 31.07.2026; er liegt nicht in diesem Repository,
// die Gruende stehen jeweils am Ort.
//
// Zeichnet bei JEDER `state.subscribe`-Benachrichtigung komplett neu
// (`list.replaceChildren()` + Neuaufbau) -- keine eigene Kopie des Baums,
// `state.hosts` bleibt die einzige Quelle. Auch das Auf- und Zuklappen geht
// ueber `AppState` (`setHostExpanded`): der Arbeitsplatz speichert die
// aufgeklappten Hosts (UX-Spec §7.1), und das Neuzeichnen kommt aus derselben
// Benachrichtigung wie bei jeder anderen Aenderung.
//
// Aufbau und Klassennamen folgen
// docs/specs/2026-07-27-agent-management-shell-mockup.html
// (dort ist die Seitenleiste vollstaendig ausgefuehrt) -- mit EINER
// bewussten Abweichung: die Hinweisleiste verwendet `<button>` statt der
// dortigen `<a>` fuer "Retry"/"Copy diagnostics". Ein Link ohne `href` ist
// kein Tab-Stopp und reagiert nicht auf Enter/Space -- das verstoesst gegen
// die Tastaturpflicht dieser Aufgabe. Gleiche Klasse (`host-notice-link`),
// damit das Aussehen erhalten bleibt.

import { AppState, sessionKeyOf, socketOf, type Host, type HostState, type Session, type SessionSocket } from "../state/app-state";
import { waitingSessions } from "../state/attention";
import { computeMenuPosition } from "./menu-position";
import { buildCredentialField, type CredentialField } from "./credential-field";
import { mountHostForm, type AuthChoice, type HostFormHandle } from "./host-form";
import { hostInitials } from "./initials";
import { appVersionLine } from "../version";
import { icon, type IconName } from "../icons";
import { titleWithShortcut } from "./shortcut-title";
import { agentStatusView, buildStatusPill } from "./status-pill";
import { buildTileNumber } from "./tile-number";
import { createWaitingLane, openOptions } from "./waiting-lane";
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

export interface SidebarOptions {
  /** `secret.passphrase`/`secret.password` sind gesetzt, wenn der Nutzer in
   * der Hinweisleiste eines fehlgeschlagenen Hosts das entsprechende Feld
   * ausgefuellt hat (siehe `buildHostNotice`) -- ob ein Feld angeboten wird,
   * entscheidet `host.errorCode` (nur nach Anmeldefehlern), welches,
   * `host.authKind` (Task 8, Spec §4.8). Ohne Eingabe bleibt `secret`
   * `undefined`, wie beim Umschaltknopf (`buildConnectToggle`). Nur im
   * Arbeitsspeicher, nie in `settings.toml`. */
  onConnectHost: (hostId: string, secret?: { passphrase?: string; password?: string }) => void;
  onDisconnectHost: (hostId: string) => void;
  onEditHost: (hostId: string) => void;
  onRemoveHost: (hostId: string) => void | Promise<void>;
  onReloadSessions: (hostId: string) => void;
  onRepairControl?: (hostId: string, auth: AuthChoice) => void;
  onCancelControlRepair?: (hostId: string) => void;
  onNewSession: (hostId: string) => void;
  /** Klick auf eine Session: oeffnen nach Spec 2026-10-19 §5.1; mit Strg die
   * fokussierte Kachel ersetzen (§5.2). */
  onOpenSession: (hostId: string, name: string, options: { replace: boolean; socket?: SessionSocket }) => void;
  /** Wie alle Rueckrufe zu einer Session mit ihrem Socket (Spec 2026-10-25 §5). */
  onCloseSession: (hostId: string, name: string, socket: SessionSocket) => void;
  /** Beendet die tmux-Session auf dem Host -- die Sitzung selbst und alles,
   * was darin laeuft. Bewusst NICHT dasselbe wie `onCloseSession`, das
   * ausdruecklich nur die Ansicht schliesst und die Sitzung weiterlaufen
   * laesst. Diese Datei ruft ihn erst nach einer Rueckfrage. */
  onKillSession: (hostId: string, name: string, socket: SessionSocket) => void;
  onAddHost: () => void;
  /** UI v2 §7.2: Zahnrad im Kopf oeffnet den Einstellungsdialog (main.ts). */
  onOpenSettings: () => void;
  /** Spec 2026-10-19 §7: Beginn der Warte-Episode je `waitingKey` (main.ts
   * fuehrt sie); ohne Angabe zaehlt jede wartende Session als "now". */
  waitingSince?: (key: string) => number | undefined;
}

export interface SidebarHandle {
  dispose(): void;
  /** Schliesst ein offenes Hostmenue. `main.ts` ruft das beim Einklappen der
   * Seitenleiste (`Ctrl+Shift+B`): die Seitenleiste kann das Einklappen
   * nicht selbst bemerken -- es schaltet nur eine Klasse an `#app` und loest
   * kein Zustandssignal aus. Idempotent. */
  closeMenu(): void;
  /** Zeigt das Formular zur Reparatur der Steuerung, ohne den Fokus zu nehmen.
   * `main.ts` ruft das, wenn die Selbstreparatur an `authentication_required`
   * endet (UX-Spec §5.3: "das bisherige Formular erscheint"). */
  openControlRepair(hostId: string): void;
  /** Der aktive Host der Seitenleiste -- derselbe, dessen Karte die
   * Aktionsleiste zeigt (`sb-host-block--active`), oder `null` ohne Hosts.
   * Nur waehrend eines Drucks in der Liste bleibt die Markierung bis nach dem
   * Klick stehen (Abnahme B2); diese Antwort folgt dem Fokus sofort.
   * Schritt 3 der Zielhost-Kette von Strg+Umschalt+N (UX-Spec §7.9). */
  activeHostId(): string | null;
}

/** Stabiler Bezeichner EINES Bedienelements, der ein Neuzeichnen ueberlebt
 * (Abschlussreview, Important 3). `render()` baut den ganzen Baum bei jeder
 * Benachrichtigung neu auf; das fokussierte Element wird dabei aus dem DOM
 * entfernt und der Fokus faellt auf `<body>` zurueck. Formal blieb alles
 * erreichbar (jede Zeile ist ein echter `<button>`), praktisch begann der
 * Tab-Weg nach JEDER Aktion wieder ganz oben im Dokument -- hinter 5xN
 * Host-Schaltflaechen. Ueber diesen Bezeichner (bewusst ein WERT, keine
 * Elementreferenz -- die Referenz ist nach `replaceChildren()` tot) findet
 * `render()` das Gegenstueck im frisch gebauten Baum wieder.
 *
 * Traegt NIE die Beschriftung: der Umschaltknopf heisst je nach Zustand
 * "Connect" oder "Disconnect", und genau ueber diesen Wechsel (via
 * `setHostState(..., "connecting")`) muss der Fokus hinweg erhalten
 * bleiben. Deshalb `toggle`, nicht `connect`. */
function focusKey(scope: string, id: string, part: string): string {
  return `${scope}:${id}:${part}`;
}

/** Fehlercodes, nach denen die Hinweisleiste eines Hosts nach einem Geheimnis
 * fragt: eine fehlende oder falsche Passphrase, ein abgelehntes Passwort (auch
 * die lokale Pruefung in `main.ts`), ein abgelehnter Schluessel oder Agent.
 * Bei Netz-, Hostschluessel- und anderen Fehlern hilft kein Geheimnis. */
const SECRET_FAILURE_CODES: ReadonlySet<string> = new Set([
  "passphrase_required",
  "password_required",
  "auth_rejected",
]);

function asksForSecret(host: Host): boolean {
  return host.errorCode != null && SECRET_FAILURE_CODES.has(host.errorCode);
}

/** Haengt Geometrie (Klasse) UND Text als eigenen Textknoten an `parent` --
 * die zwei sichtbaren Kanaele der Drei-Kanal-Regel (der dritte, Fuellung,
 * steckt in der Klasse selbst, siehe `styles.css`). NIE nur die Klasse ohne
 * diesen Text, sonst waere Form/Farbe die einzige Absicherung eines
 * Zustands -- genau das, was diese Aufgabe ausschliesst.
 *
 * Gegenprobe-Marker: wird der `appendChild(text)`-Aufruf unten entfernt,
 * muss GENAU der Test "zeigt jeden Zustand mit Form UND Text, nie mit Farbe
 * allein" (`sidebar.test.ts`) rot werden -- die anderen vier duerfen das
 * nicht, sie pruefen diesen Text nicht. */
function appendIndicator(parent: HTMLElement, indClass: string, label: string): void {
  const ind = document.createElement("span");
  ind.className = indClass;
  parent.appendChild(ind);
  const text = document.createTextNode(label);
  parent.appendChild(text);
}

/** Haengt die Glyphe eines Icon-Knopfs an, im 16er-Kasten und `aria-hidden` --
 * den Namen traegt der Knopf selbst. */
function appendIconBox(button: HTMLButtonElement, iconName: IconName): void {
  const box = document.createElement("span");
  box.className = "icon-box";
  box.setAttribute("aria-hidden", "true");
  // Der Name steht zusaetzlich als Datenattribut da, wie am Chevron der
  // Hostzeile: das SVG selbst traegt nur Pfade.
  box.dataset.icon = iconName;
  box.appendChild(icon(iconName));
  button.appendChild(box);
}

/** Beschriftet einen Icon-Knopf: Glyphe, Name in `title` UND -- visuell
 * versteckt -- als Text, damit `textContent` und die Ansage die Beschriftung
 * bleiben (v2 §13.2). Fuer die Icon-Knoepfe der Sessionzeile
 * (`buildActionButton`) und "Reload sessions" in der Hostleiste
 * (`buildReloadButton`). */
function appendIconLabel(button: HTMLButtonElement, label: string, iconName: IconName): void {
  button.title = label;
  appendIconBox(button, iconName);
  const text = document.createElement("span");
  text.className = "ab-visually-hidden";
  text.textContent = label;
  button.appendChild(text);
}

/** Task 16, Punkt B: die Pille sagt "Online"/"Offline" statt
 * "Connected"/"Disconnected". Bei 240 px Leistenbreite blieben dem Hostnamen
 * neben der langen Fassung nur rund 40 px -- IP-Adressen wurden abgeschnitten.
 * Seit Aufgabe 16 tragen `sidebar.pill.*` die Pillenwoerter.
 * "Connecting…"/"Failed" sind schon kurz und behalten ihre eigenen Schluessel. */
function hostIndicator(state: HostState): { cls: string; label: string } {
  switch (state) {
    case "connected":
      return { cls: "ind ind-on", label: t("sidebar.pill.connected") };
    case "disconnected":
      return { cls: "ind ind-off", label: t("sidebar.pill.disconnected") };
    case "connecting":
      return { cls: "ind ind-connecting", label: t("sidebar.state.connecting") };
    case "failed":
      return { cls: "ind ind-fail", label: t("sidebar.state.failed") };
  }
}

/** Nachtrag B, Punkt 3 (Designsystem §8.4): eine gesperrte Eingabe ist ein
 * EIGENER Zustand mit eigener Geometrie (Dreieck, 8x8 -- nicht das kleine
 * 6x6-Quadrat von offen/geschlossen), nicht nur eine gefaerbte Variante von
 * "offen". Sie ueberdeckt deshalb `session.open` in dieser Funktion: eine
 * Session, deren Kanal die Verbindung verlor, ist fuer den Nutzer weder
 * "offen" (sie nimmt keine Eingabe mehr an) noch "geschlossen" (sie laeuft
 * auf dem Host weiter) -- das eigene Formvokabular sagt genau das.
 *
 * Ausnahme UX-Spec §5.4: verbindet die App den Host gerade selbst neu, warnt
 * die Zeile nicht. Hostzeile und Kachel sagen dann ruhig "Reconnecting…", und
 * die offene Session bleibt "Open"; erst wenn die Reihe ohne Verbindung
 * endet, steht die Warnung wieder -- zugleich mit der Sperrleiste. */
function sessionIndicator(session: Session, hostReconnecting = false): { cls: string; label: string } {
  if (session.inputLocked && !hostReconnecting) {
    return { cls: "ind ind-warn", label: t("sidebar.state.inputLocked") };
  }
  return session.open
    ? { cls: "ind ind-sm ind-on", label: t("sidebar.state.sessionOpen") }
    : { cls: "ind ind-sm ind-off", label: t("sidebar.state.sessionClosed") };
}

export function mountSidebar(el: HTMLElement, state: AppState, opts: SidebarOptions): SidebarHandle {
  let disposed = false;
  el.replaceChildren();

  const root = document.createElement("div");
  root.className = "sidebar";

  const head = document.createElement("div");
  head.className = "sb-head";
  const heading = document.createElement("h1");
  heading.textContent = t("sidebar.heading");
  head.appendChild(heading);

  // UI v2 §7.2: der Add-Knopf steht seit Aufgabe 8 IM KOPF, zwischen
  // Ueberschrift und Zahnrad -- der Fuss traegt nur noch die Versionszeile.
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "sb-btn";
  // Das Plus ist ein Icon, kein Text: eigenes, `aria-hidden`-markiertes
  // Element im 16er-Kasten (§13.1/§13.2), damit weder eine Uebersetzung noch
  // eine Screenreader-Ansage dafuer noetig ist -- der Name steht daneben.
  // 14 statt 16 Pixel: das Icon sitzt in einem Knopf in Textgroesse `sm`,
  // ein 16er-Glyph ueberragte den Text darin sichtbar.
  const addIcon = document.createElement("span");
  addIcon.className = "icon-box";
  addIcon.setAttribute("aria-hidden", "true");
  addIcon.appendChild(icon("plus", 14));
  addButton.appendChild(addIcon);
  addButton.appendChild(document.createTextNode(t("sidebar.addHost")));
  // Bleibt "foot": Fokusschluessel sind Vertraege der Tests, kein Ortsname.
  // (Spec 16.2 -- der Knopf ist nur umgezogen, nicht ersetzt.) Liegt
  // ausserhalb von `list` und wird von `render()` gar nicht neu gebaut; der
  // Bezeichner ist trotzdem gesetzt, damit die Wiederherstellung in
  // `render()` keinen Sonderfall fuer "war auf einem nicht neu gebauten
  // Element fokussiert" braucht.
  addButton.dataset.focusKey = focusKey("foot", "", "add");
  addButton.addEventListener("click", () => {
    if (!disposed) opts.onAddHost();
  });
  head.appendChild(addButton);

  const settingsButton = document.createElement("button");
  settingsButton.type = "button";
  settingsButton.className = "sb-head-btn";
  // Icon ohne Text: darum `title` UND `aria-label` (v1 §9 Nr. 11, v2 §13.2).
  // Der Tooltip nennt das Kuerzel Strg+, aus der Tabelle (UX-Spec §8.4).
  settingsButton.title = titleWithShortcut(t("sidebar.settings"), "settings.open");
  settingsButton.setAttribute("aria-label", t("sidebar.settings"));
  settingsButton.dataset.focusKey = focusKey("head", "", "settings");
  settingsButton.appendChild(icon("settings"));
  settingsButton.addEventListener("click", () => {
    if (!disposed) opts.onOpenSettings();
  });
  head.appendChild(settingsButton);
  root.appendChild(head);

  const list = document.createElement("div");
  list.className = "sb-list";
  root.appendChild(list);

  // Spec 2026-10-19 §7: die Wartet-Spur steht ueber den Hosts; `render()` holt
  // sie bei jedem Neuzeichnen aus `lane.build`.
  const lane = createWaitingLane(list, {
    state,
    isCurrent: (h, s) => state.isSessionStatusCurrent(h.id, s.name, socketOf(s)),
    waitingSince: (key) => opts.waitingSince?.(key),
    onOpenSession: (hostId, name, options) => {
      if (!disposed) opts.onOpenSession(hostId, name, options);
    },
    requestRender: () => {
      if (!disposed) render();
    },
  });

  // Der Fuss traegt seit Aufgabe 8 NUR NOCH die Versionszeile -- Version und
  // Commit, still am Fuss der Seitenleiste (Task 9), dieselbe Zeichenkette
  // wie in `Copy diagnostics` oben und aus derselben Quelle
  // (`appVersionLine()`). Der Stil kommt aus `.sb-version` in `styles.css`;
  // die frueheren Inline-Stile waren nur noetig, solange `styles.css` fuer
  // jene Aufgabe unveraendert bleiben musste.
  const foot = document.createElement("div");
  foot.className = "sb-foot";
  const versionLine = document.createElement("div");
  versionLine.className = "sb-version";
  versionLine.textContent = appVersionLine();
  foot.appendChild(versionLine);

  root.appendChild(foot);

  el.appendChild(root);

  // --- Das Hostmenue (Entwurf §1) -------------------------------------
  //
  // Es haengt an `root`, NICHT an `list`: `render()` ersetzt allein die
  // Kinder von `list`, also ueberlebt das Menue jedes Neuzeichnen -- und
  // damit erledigen sich drei Sonderfaelle von selbst. `Ctrl+Shift+B`
  // blendet `#sidebar` per `display: none` aus und nimmt es mit; `openDialog`
  // setzt `#app.inert` und deckt es; `dispose()` raeumt `el` und damit auch
  // dieses DOM.
  //
  // Geschlossen heisst NICHT IM DOM. Nicht "versteckt": `focusableElements`
  // (dialog.ts) filtert allein ueber die `hidden`-Eigenschaft, ein per CSS
  // verstecktes Menue mit einem `tabindex="0"`-Eintrag waere also ein
  // vierter Tabulator-Halt und broeche das Versprechen aus §3.2.
  let openMenuHostId: string | null = null;
  let menuEl: HTMLElement | null = null;
  const controlEditors = new Map<string, { runtimeId: string | null; root: HTMLElement; handle: HostFormHandle }>();

  function closeControlEditor(hostId: string): void {
    controlEditors.get(hostId)?.handle.dispose();
    controlEditors.delete(hostId);
  }

  function openControlEditor(host: Host, takeFocus = true): void {
    if (controlEditors.has(host.id)) return;
    const root = document.createElement("div");
    root.className = "control-repair-form";
    const auth: AuthChoice = host.authKind === "key" && host.keyPath
      ? { kind: "key", path: host.keyPath, passphrase: "" }
      : host.authKind === "password" ? { kind: "password", password: "" } : { kind: "agent" };
    const handle = mountHostForm(root, {
      mode: "control-repair", existing: [],
      initial: { hostname: host.hostname, user: host.user, port: host.port, auth },
      onSubmit: ({ auth }) => {
        closeControlEditor(host.id);
        render();
        opts.onRepairControl?.(host.id, auth);
      },
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn--secondary btn--row";
    cancel.textContent = t("control.cancel");
    cancel.addEventListener("click", () => { closeControlEditor(host.id); render(); });
    root.appendChild(cancel);
    controlEditors.set(host.id, { runtimeId: host.runtimeId, root, handle });
    render();
    if (takeFocus) root.querySelector<HTMLSelectElement>("select")?.focus();
  }

  function menuItems(): HTMLElement[] {
    return menuEl ? Array.from(menuEl.querySelectorAll<HTMLElement>('[role="menuitem"]')) : [];
  }

  /** Einziger Schreiber von `tabindex="0"` im Menue -- die Eintraege selbst
   * werden unbedingt mit `-1` gebaut. Zwei Schreiber desselben Attributs
   * waeren eine Frage der Aufrufreihenfolge, und die verliert man. */
  function applyMenuRoving(index: number, takeFocus: boolean): void {
    const itemList = menuItems();
    itemList.forEach((item, i) => {
      item.tabIndex = i === index ? 0 : -1;
    });
    if (takeFocus) itemList[index]?.focus();
  }

  function moveMenuTo(index: number): void {
    const itemList = menuItems();
    if (itemList.length === 0) return;
    const wrapped = (index + itemList.length) % itemList.length;
    applyMenuRoving(wrapped, true);
  }

  function onMenuKeyDown(event: KeyboardEvent): void {
    if (disposed || !menuEl) return;
    const itemList = menuItems();
    const current = itemList.indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); moveMenuTo(current + 1); break;
      case "ArrowUp": event.preventDefault(); moveMenuTo(current - 1); break;
      case "Home": event.preventDefault(); moveMenuTo(0); break;
      case "End": event.preventDefault(); moveMenuTo(itemList.length - 1); break;
      case "Escape":
        event.preventDefault();
        // MUSS die Weitergabe stoppen: main.ts haengt einen dauerhaften
        // Dokument-Horcher, der eine maximierte Kachel zurueckholt und
        // weder auf Menues noch auf diese Leiste prueft.
        event.stopPropagation();
        closeMenu();
        break;
      case "Tab":
        // KEIN preventDefault: der Tabulator soll weiterziehen.
        closeMenu();
        break;
    }
  }

  function onDocumentPointerDown(event: MouseEvent): void {
    if (disposed || !menuEl) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    // Gegen BEIDES geprueft -- gegen das Menue und gegen den Knopf. Ohne die
    // zweite Haelfte schloesse der Klick, der oeffnet, sofort wieder: dieser
    // Horcher wird in `openMenu` SYNCHRON angemeldet und faengt darum noch
    // dasselbe Ereignis, wenn es weiter zum Dokument blubbert (nachgemessen,
    // unter jsdom wie im Browser). Ein `queueMicrotask` um die Anmeldung
    // waere KEINE Alternative: die Mikroaufgabe laeuft erst, wenn der
    // Aufrufstapel leer ist -- also nach dem gesamten Ereignisversand --,
    // sie machte diese Wachhaelfte zu totem Code und einen Test auf "Klick
    // ausserhalb schliesst" (der ohne zwischenzeitliches `await` klickt)
    // wirkungslos gruen.
    if (target.closest('[role="menu"]') || target.closest(".host-menu-btn")) return;
    closeMenu();
  }

  // Rechts- und Mittelklick erzeugen kein `click`: der Horcher darauf sieht sie
  // nie. Ein Rechtsklick ins Terminal liesse dieses Menue sonst neben dem
  // Terminalmenue offen (`terminal.ts` haelt die rechte Taste auch von
  // `auxclick` fern). Eigener Horcher in der CAPTURE-Phase, weil das Terminal
  // die rechte Taste an seinem Container stoppt. Die linke Taste bleibt beim
  // `click`: dessen Weg samt Fokus zurueck an den ⋯-Knopf aendert sich nicht.
  function onDocumentAuxPointerDown(event: MouseEvent): void {
    if (event.button !== 0) onDocumentPointerDown(event);
  }

  function onWindowResize(): void {
    if (!disposed) closeMenu();
  }

  function onListScroll(): void {
    if (!disposed) closeMenu();
  }

  function moreButtonFor(hostId: string): HTMLButtonElement | null {
    const wanted = focusKey("host", hostId, "more");
    return (
      Array.from(list.querySelectorAll<HTMLButtonElement>(".host-menu-btn")).find(
        (b) => b.dataset.focusKey === wanted,
      ) ?? null
    );
  }

  function positionMenu(): void {
    if (!menuEl || openMenuHostId === null) return;
    const anchor = moreButtonFor(openMenuHostId);
    if (!anchor) {
      // Der Host ist fort -- ein Menue ohne Host ist eine Sackgasse.
      closeMenu(false);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const placement = computeMenuPosition(
      { left: rect.left, top: rect.top, bottom: rect.bottom },
      menuEl.getBoundingClientRect().height,
      window.innerHeight,
    );
    menuEl.style.left = `${placement.left}px`;
    menuEl.style.top = `${placement.top}px`;
  }

  function buildMenuItem(label: string, onActivate: () => void, extraClass?: string): HTMLElement {
    // Eigener Bauer statt `buildActionButton`: ein Menueeintrag ist kein
    // `.host-action-btn` mit anderer Klasse, er hat eine andere Rolle.
    //
    // Und bewusst OHNE `data-focus-key`: `render()`s Fokusrettung durchsucht
    // ALLE `[data-focus-key]` unter `el` und nimmt den ersten Treffer -- ein
    // Menueeintrag mit Bezeichner koennte den einer Zeile verdecken und eine
    // Wiederherstellung an sich reissen.
    const item = document.createElement("button");
    item.type = "button";
    item.className = extraClass ? `sb-menu-item ${extraClass}` : "sb-menu-item";
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    item.textContent = label;
    item.addEventListener("click", () => {
      if (disposed) return;
      // ERST schliessen und den Fokus zurueckgeben, DANN handeln.
      // `openDialog` merkt sich beim Oeffnen `document.activeElement` als
      // Rueckkehrziel -- umgekehrt merkte es sich einen Menueeintrag, den es
      // beim Schliessen nicht mehr gibt.
      closeMenu();
      onActivate();
    });
    return item;
  }

  function openMenu(hostId: string, focusWhich: "first" | "last" = "first"): void {
    if (disposed) return;
    closeMenu(false);
    const host = state.hosts.find((h) => h.id === hostId);
    if (!host) return;

    openMenuHostId = hostId;
    menuEl = document.createElement("div");
    menuEl.className = "sb-menu";
    menuEl.setAttribute("role", "menu");
    // "Reload sessions" steht seit UX-Spec §7.8 als Icon-Knopf in der Leiste
    // (`buildReloadButton`), nicht mehr hier.
    menuEl.appendChild(
      buildMenuItem(t("sidebar.action.editEllipsis"), () => opts.onEditHost(hostId)),
    );
    const separator = document.createElement("div");
    separator.className = "sb-menu-separator";
    separator.setAttribute("role", "separator");
    menuEl.appendChild(separator);
    menuEl.appendChild(
      buildMenuItem(t("sidebar.action.removeEllipsis"), () => {
        // Das Ellipsenzeichen im Namen war seit Task 2 ein Versprechen: der
        // Eintrag fragt nach, statt sofort zu handeln. Hier wird es
        // eingeloest -- er oeffnet die Leiste, `opts.onRemoveHost` ruft erst
        // deren "Remove"-Knopf.
        pendingRemoveHostId = hostId;
        render();
        // Fokus auf "Cancel" -- die eine Ausnahme von der Regel aus §1.6,
        // dass ein schliessendes Menue den Fokus an den `⋯`-Knopf
        // zurueckgibt. `buildMenuItem` hat ihn dorthin gestellt, BEVOR diese
        // Funktion laeuft; ohne diesen Griff bliebe er dort, und die
        // Rueckfrage waere mit der Tastatur unbeantwortbar.
        focusConfirmCancel(hostId);
      }, "sb-menu-item-danger"),
    );
    menuEl.addEventListener("keydown", onMenuKeyDown);
    root.appendChild(menuEl);

    moreButtonFor(hostId)?.setAttribute("aria-expanded", "true");
    positionMenu();
    // `positionMenu()` kann bei fehlendem Anker bereits geschlossen haben --
    // dann gibt es nichts mehr anzumelden, und die vier Horcher unten waeren
    // heimatlos zurueckgeblieben.
    if (!menuEl) return;
    applyMenuRoving(focusWhich === "first" ? 0 : menuItems().length - 1, true);

    document.addEventListener("click", onDocumentPointerDown);
    document.addEventListener("mousedown", onDocumentAuxPointerDown, true);
    window.addEventListener("resize", onWindowResize);
    // AN `.sb-list`, nicht an `window`: `scroll` blubbert nicht.
    list.addEventListener("scroll", onListScroll);
  }

  function closeMenu(restoreFocus = true): void {
    // VOR der Wache unten: das Abmelden muss auch dann laufen, wenn kein
    // Menue (mehr) steht -- ein `removeEventListener` fuer einen nie
    // angemeldeten Horcher ist folgenlos, ein zurueckgelassener Horcher am
    // `window` dagegen ueberlebt jedes Aufraeumen des DOM.
    document.removeEventListener("click", onDocumentPointerDown);
    document.removeEventListener("mousedown", onDocumentAuxPointerDown, true);
    window.removeEventListener("resize", onWindowResize);
    list.removeEventListener("scroll", onListScroll);
    if (!menuEl) {
      openMenuHostId = null;
      return;
    }
    const hostId = openMenuHostId;
    menuEl.removeEventListener("keydown", onMenuKeyDown);
    menuEl.remove();
    menuEl = null;
    openMenuHostId = null;
    if (hostId === null) return;
    // Ueber den WERT, nie ueber eine Elementreferenz: der Knopf kann
    // zwischenzeitlich neu gebaut worden sein, `.focus()` auf dem alten
    // Knoten waere ein Nichts und der Fokus landete auf <body>.
    const button = moreButtonFor(hostId);
    // ERST fokussieren, DANN das Attribut zuruecksetzen: seit der
    // Seitenleisten-Umstellung haelt
    // `.sb-host-block:not(.sb-host-block--active):not(.sb-host-block--held):not(:focus-within):not(:has(.host-actions [aria-expanded="true"])) .host-actions`
    // (styles.css) die Knopfleiste eines nicht aktiven Hosts nur wegen des
    // offenen Menues sichtbar. In der umgekehrten Reihenfolge waere der
    // Knopf im Moment des `focus()` bereits `display: none` -- der Fokus
    // landete auf <body>, statt dorthin zurueckzukehren, wo das Menue
    // geoeffnet wurde.
    if (restoreFocus) button?.focus();
    button?.setAttribute("aria-expanded", "false");
  }

  /** EIN Knopf, der zwischen "Connect" und "Disconnect" umschaltet, statt
   * zweier gleichzeitig sichtbarer -- die Aktion ergibt sich eindeutig aus
   * `host.state` (Spec §6.3: "Host, nicht verbunden -> Verbinden" /
   * "Host, verbunden -> Trennen" sind einander ausschliessende Zeilen
   * derselben Tabelle, kein Zustand erlaubt beides). */
  function buildConnectToggle(host: Host): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "host-action-btn";
    // UNBEDINGT `-1`; `applyToolbarRoving` ist der einzige Schreiber der `0`
    // in den Knopfleisten (dieselbe Regel wie bei den Zeilen).
    button.tabIndex = -1;
    // `toggle`, NICHT `connect`/`disconnect` -- siehe `focusKey`: der
    // Bezeichner muss den Beschriftungswechsel ueberleben.
    button.dataset.focusKey = focusKey("host", host.id, "toggle");
    const connectedOrConnecting = host.state === "connected" || host.state === "connecting";
    button.textContent = connectedOrConnecting
      ? t("sidebar.action.disconnect")
      : t("sidebar.action.connect");
    button.addEventListener("click", () => {
      if (disposed) return;
      if (connectedOrConnecting) opts.onDisconnectHost(host.id);
      else opts.onConnectHost(host.id);
    });
    return button;
  }

  /** Ein Icon-Knopf der Sessionzeile (Task 16, Punkt A), beschriftet ueber
   * `appendIconLabel`. Er traegt die Klasse `host-action-btn` ausdruecklich
   * NICHT -- er liegt in `.session-acts` und wird dort gesucht. Die Knoepfe
   * der Hostleiste bauen `buildConnectToggle`, `buildNewSessionButton`,
   * `buildReloadButton` und `buildMoreButton`. */
  function buildActionButton(
    label: string,
    focusKeyValue: string,
    onClick: () => void,
    extraClass: string,
    iconName: IconName,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.focusKey = focusKeyValue;
    button.className = `${extraClass} btn btn--text btn--row session-icon-btn`;
    appendIconLabel(button, label, iconName);
    button.addEventListener("click", () => {
      if (!disposed) onClick();
    });
    return button;
  }

  /** Sichtbare Knoepfe plus ein Aufklappmenue (Entwurf §1.2): sichtbar
   * bleibt, was man im Betrieb braucht -- der Verbindungsumschalter, "New
   * session" und seit UX-Spec §7.8 "Reload sessions", die beiden letzten als
   * Icon-Knoepfe --, hinter dem `⋯` liegt, was man selten tut (Bearbeiten,
   * Entfernen).
   *
   * Der frueher hier stehende Kommentar begruendete fuenf flache Knoepfe
   * mit einem Aufgabentext ("keine Kontextmenues ueber die im Interface
   * genannten Aktionen hinaus"), der in keinem Entwurf, keinem Plan und
   * keinem Commit dieses Projekts auffindbar ist -- und dem die inzwischen
   * getroffene Entscheidung ausdruecklich widerspricht.
   *
   * Eigenes `<div>`, NEBEN der Host-Zeile, nie darin -- ein `<button>` im
   * `<button>` waere ungueltig und fuer Tastaturfokus nicht sinnvoll
   * ansteuerbar. */
  function buildHostActions(host: Host): HTMLElement {
    const actions = document.createElement("div");
    actions.className = "host-actions";
    actions.appendChild(buildConnectToggle(host));
    actions.appendChild(buildNewSessionButton(host));
    actions.appendChild(buildReloadButton(host));
    actions.appendChild(buildMoreButton(host));
    return actions;
  }

  /** "New session" ist seit Aufgabe 19 (Fixrunde
   * 1) ein Icon-Knopf `plus`: erst so passen Umschalter, "New session",
   * "Reload sessions" und `⋯` bei 240 px in eine Zeile. Der Name steht in
   * `aria-label`, der Tooltip nennt das Kuerzel aus der aktiven Tabelle
   * (UX-Spec §8.4) -- das loest den frueheren Entscheid ab, am Host kein
   * Kuerzel zu nennen, weil Strg+Umschalt+N zuerst den Host der fokussierten
   * Kachel nimmt (§7.9).
   *
   * Task 16, Punkt E (Spec 11.2, natives `disabled`): eine neue Session
   * braucht eine lebende Verbindung. Bis dahin stand der Knopf an jedem Host
   * und beantwortete den Klick mit einer Fehlermeldung -- die Absage gehoert
   * an den Knopf, nicht hinter ihn. Die Wache in `main.ts` (`onNewSession`)
   * bleibt: der Tastaturweg `Ctrl+Shift+N` kommt nicht ueber diesen Knopf, und
   * zwischen Oeffnen und Absenden des Dialogs kann die Verbindung fallen. */
  function buildNewSessionButton(host: Host): HTMLButtonElement {
    const label = t("sidebar.action.newSession");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "host-action-btn host-icon-btn";
    // UNBEDINGT `-1`, siehe `buildConnectToggle`.
    button.tabIndex = -1;
    button.dataset.focusKey = focusKey("host", host.id, "newSession");
    button.setAttribute("aria-label", label);
    button.title = titleWithShortcut(label, "session.new");
    appendIconBox(button, "plus");
    button.disabled = host.state !== "connected";
    button.addEventListener("click", () => {
      if (!disposed) opts.onNewSession(host.id);
    });
    return button;
  }

  /** UX-Spec §7.8: "Reload sessions" ist ein Icon-Knopf `refresh-cw` der
   * Leiste, vor dem `⋯`, kein Menueeintrag mehr. Geometrie und Roving wie
   * seine Nachbarn (`host-action-btn`, quadratisch ueber `host-icon-btn`),
   * beschriftet wie die Icon-Knoepfe der Sessionzeile. Der Tooltip ist der
   * blosse Name: die Aktion hat kein Kuerzel (§8.4).
   *
   * Nur am verbundenen Host bedienbar, wie "New session" daneben (Fixrunde 1):
   * sonst taete der Klick nichts -- `refreshSessions` (main.ts) setzt an einem
   * getrennten Host gar keinen Aufruf ab, und diese Wache bleibt als zweite
   * Linie stehen. Ebenso gesperrt, solange die Steuerung nicht bereit ist
   * (UX-Spec §5.3): das Neuladen scheiterte an ihr, und ihre ruhige Zeile bzw.
   * ihr Kasten sagt schon, dass die Liste nicht nachkommt. */
  function buildReloadButton(host: Host): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "host-action-btn host-icon-btn";
    // UNBEDINGT `-1`, siehe `buildConnectToggle`.
    button.tabIndex = -1;
    button.dataset.focusKey = focusKey("host", host.id, "reload");
    appendIconLabel(button, t("sidebar.action.reload"), "refresh-cw");
    button.disabled = host.state !== "connected" || state.controlForHost(host.id).state !== "ready";
    button.addEventListener("click", () => {
      if (!disposed) opts.onReloadSessions(host.id);
    });
    return button;
  }

  /** Der `⋯`-Knopf. `⋯` ist ein Ornament, kein Text -- der zugaengliche Name
   * kommt aus i18n, das Glyph traegt `aria-hidden` (dasselbe Muster wie das
   * `+` am "Add host"-Knopf im KOPF; der Fuss traegt seit Aufgabe 8 nur noch
   * die Versionszeile). */
  function buildMoreButton(host: Host): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "host-action-btn host-menu-btn";
    // UNBEDINGT `-1`, siehe `buildConnectToggle`.
    button.tabIndex = -1;
    button.dataset.focusKey = focusKey("host", host.id, "more");
    button.setAttribute("aria-label", t("sidebar.action.more"));
    button.title = t("sidebar.action.more");
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", String(openMenuHostId === host.id));
    const glyph = document.createElement("span");
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = "⋯";
    button.appendChild(glyph);
    button.addEventListener("click", () => {
      if (disposed) return;
      if (openMenuHostId === host.id) closeMenu();
      else openMenu(host.id);
    });
    button.addEventListener("keydown", (event) => {
      if (disposed) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        openMenu(host.id, "first");
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        openMenu(host.id, "last");
      }
    });
    return button;
  }

  // --- Rueckfrage vor dem Entfernen (Entwurf §2.2) ---------------------

  /** Reiner Anzeigezustand dieser Leiste -- kein `AppState`-Mutator dafuer,
   * nichts davon wird gespeichert. `string | null` und nicht eine Menge: genau
   * EINE offene Rueckfrage. Zwei gleichzeitig waeren eine Einladung, die
   * falsche zu bestaetigen. */
  let pendingRemoveHostId: string | null = null;
  const removalsInFlight = new Set<string>();

  /** Der Sessionschluessel, dessen "Beenden"-Rueckfrage gerade offen steht.
   * Hoechstens eine, aus demselben Grund wie oben. */
  let pendingKillKey: string | null = null;

  /** Fokussiert ein Element, das eine Sessionaktion sein KANN (Task 16, Punkt
   * A). Der Umweg ist noetig, weil `.session-acts` per `visibility: hidden`
   * verborgen ist, solange die Zeile weder ausgewaehlt noch beruehrt ist noch
   * den Fokus traegt -- und ein Browser fokussiert nichts unter
   * `visibility: hidden`. Beide Wege, die einen dieser Knoepfe programmatisch
   * ansteuern (`closeKillConfirm` und `render()`s Fokusrettung), kommen aus
   * einem Zustand OHNE Fokus in der Zeile: das vorangegangene `render()` hat
   * den alten Knoten entfernt, der Fokus liegt auf <body>. Der Ruf ginge ins
   * Leere, und der Nutzer, der eben per Tastatur gearbeitet hat, staende auf
   * <body> -- der naechste Tabulator begaenne ganz oben im Dokument.
   *
   * Erst die ZEILE fokussieren schaltet `:focus-within` und damit die
   * Sichtbarkeit ein; der zweite Ruf trifft dann ein sichtbares Element.
   * Scheitert er dennoch, bleibt der Fokus wenigstens auf der Zeile.
   *
   * jsdom wendet weder `:focus-within` noch die Fokussierbarkeitsregel an --
   * dort waere schon der direkte Ruf erfolgreich, dieser Umweg ist also
   * durch keinen Test dieses Baums gedeckt, sondern durch die Sichtpruefung
   * am Fenster.
   *
   * Dasselbe gilt fuer die Knopfleiste eines Hosts, nur strenger: sie ist per
   * `display: none` verborgen, solange ihr Block weder aktiv noch
   * `:focus-within` ist, und `render()` baut die Bloecke ohne die Aktiv-Klasse.
   * Deshalb wird der Block ZUERST markiert. `applyActiveHostClass()` leitet die
   * Markierung danach wieder ab (im `focusin`-Abgleich und am Ende von
   * `render()`); steht der Fokus dann in dieser Leiste, ist ihr Host der
   * aktive. Ueber die Hostzeile zu gehen wie bei der Sessionzeile hiesse, den
   * Zeiger der Liste mitzuziehen -- er darf auf einer Sessionzeile stehen
   * bleiben (siehe den `focusin`-Abgleich der Knopfleiste). */
  function focusSessionAction(node: HTMLElement): void {
    if (node.closest(".session-acts")) {
      node.closest(".sb-session-row")?.querySelector<HTMLElement>(".ab-row")?.focus();
    }
    if (node.closest(".host-actions")) {
      node.closest(".sb-host-block")?.classList.add("sb-host-block--active");
    }
    node.focus();
  }

  /** Das Element mit diesem Bezeichner in der Liste, sonst `null`. */
  function findByKey(wanted: string): HTMLElement | null {
    // Ueber die EIGENSCHAFT verglichen, nicht per Attributselektor -- dieselbe
    // Regel wie in `render()`s Fokusrettung und in `moreButtonFor`: ein
    // Sessionname stammt aus tmux und geht ungefiltert in den Bezeichner
    // ein. Ein Selektorstring muesste dafuer maskiert werden, und ein
    // `"`-Zeichen (eine fremde Session auf demselben Socket kann eines
    // tragen) liesse `querySelector` mit einer DOMException werfen -- mitten
    // im Klickbehandler, mit einer Rueckfrage, die dann ohne Fokus dasteht.
    for (const node of list.querySelectorAll<HTMLElement>("[data-focus-key]")) {
      if (node.dataset.focusKey === wanted) return node;
    }
    return null;
  }

  /** Fokus per WERT des Bezeichners, ueber die ganze Liste -- dasselbe
   * Vokabular wie `focusConfirmCancel` unten, nur ohne dessen Festlegung auf
   * `.host-confirm-remove`. Referenzen taugen hier grundsaetzlich nicht: das
   * `render()` unmittelbar davor hat den Knoten gerade neu gebaut. */
  function focusByKey(wanted: string): void {
    const node = findByKey(wanted);
    if (node) focusSessionAction(node);
  }

  /** Rueckfrage schliessen, Fokus zurueck an den Knopf, von dem sie kam --
   * dasselbe Muster wie `closeRemoveConfirm`. */
  function closeKillConfirm(key: string): void {
    pendingKillKey = null;
    render();
    focusByKey(focusKey("session", key, "kill"));
  }

  /** Ueber den WERT des Bezeichners, wie `moreButtonFor` -- und ausdruecklich
   * erst NACH dem `render()`, das die Leiste ueberhaupt baut: eine vorher
   * gemerkte Referenz gaebe es zu diesem Zeitpunkt noch gar nicht, und nach
   * dem naechsten `replaceChildren()` waere sie ein Knoten ausserhalb des
   * Dokuments, auf dem `.focus()` folgenlos bliebe. */
  function focusConfirmCancel(hostId: string): void {
    const wanted = focusKey("confirm", hostId, "cancel");
    Array.from(list.querySelectorAll<HTMLButtonElement>(".host-confirm-remove button"))
      .find((b) => b.dataset.focusKey === wanted)
      ?.focus();
  }

  /** Abbrechen: die Leiste geht, der Fokus kehrt an den `⋯`-Knopf zurueck --
   * von dort kam sie. Ueber den WERT gesucht, nie ueber eine Referenz: das
   * `render()` eine Zeile darueber hat den Knopf gerade neu gebaut. */
  function closeRemoveConfirm(hostId: string): void {
    pendingRemoveHostId = null;
    render();
    moreButtonFor(hostId)?.focus();
  }

  /** Die Rueckfrage vor dem Entfernen -- eine schmale Leiste IM Block des
   * Hosts, kein Dialog: sie gehoert zu genau einer Zeile, und eine
   * Ueberlagerung risse den Blick aus der Liste, in der man gerade arbeitet.
   *
   * Der Satz ueber die weiterlaufenden Sessions ist Pflicht, nicht Zierde:
   * "Remove" trennt die Verbindung und entfernt den Eintrag, es beendet
   * KEINE tmux-Session. Das ist die eine nicht selbstverstaendliche Folge
   * dieser Aktion -- und die einzige, wegen der jemand zoegern koennte.
   *
   * Beide Knoepfe tragen `tabindex="-1"`: die Leiste ist NICHT Teil des
   * Roving-Modells, ein vierter Tabulatorhalt braeche das Versprechen aus
   * §3.2. Genau deshalb MUSS der Fokus beim Oeffnen auf "Cancel" springen --
   * sonst waere die Rueckfrage sichtbar, aber mit der Tastatur
   * unbeantwortbar. */
  function buildRemoveConfirm(host: Host): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "host-confirm-remove";

    // Beschreibung statt Beschriftung, und an BEIDEN Knoepfen: der Fokus
    // springt beim Oeffnen programmatisch auf "Cancel" (§2.3), ein
    // Screenreader liest dann nur "Cancel, Schaltflaeche" vor -- der
    // Hostname und der Satz ueber die weiterlaufenden Sessions, den §2.1
    // "Pflicht, nicht Zierde" nennt, kaemen nie an. `aria-describedby` wird
    // bei genau diesem Sprung mitgesprochen.
    //
    // NICHT `role="group"` + `aria-labelledby`: eine Gruppenbeschriftung
    // wird bei programmatischem Fokuswechsel nicht verlaesslich angesagt,
    // und die Ansage GENAU DANN ist der ganze Zweck.
    //
    // Kein achter i18n-Schluessel -- beschrieben wird der Text, der ohnehin
    // schon dasteht. Die Kennungen sind ueber `host.id` vereindeutigt: das
    // ist seit Paket 2.5 immer die `settings.toml`-ID aus `new_host_id`
    // (`commands.rs`, Format `host_<hex>`) und nicht mehr `next_host_id`s
    // `h<n>`. Entscheidend ist beide Male dasselbe -- das Format enthaelt
    // kein Leerzeichen, das die Liste in `aria-describedby` zerteilen
    // koennte. Gleichzeitig offen ist ohnehin nur EINE Rueckfrage.
    const questionId = `ab-confirm-q-${host.id}`;
    const noteId = `ab-confirm-n-${host.id}`;

    const question = document.createElement("strong");
    question.id = questionId;
    // Eingesetzt, NICHT zusammengesetzt: die Satzstellung gehoert der
    // Uebersetzung, nicht dieser Datei.
    question.textContent = t("sidebar.confirmRemove.question", { host: host.label });
    bar.appendChild(question);
    // Ein `<span>` statt des blossen Textknotens von frueher, damit der Satz
    // eine Kennung tragen kann. Inline und ohne eigene Regel in `styles.css`
    // -- am Umbruch aendert sich nichts.
    const note = document.createElement("span");
    note.id = noteId;
    note.textContent = t("sidebar.confirmRemove.note");
    bar.appendChild(note);
    const describedBy = `${questionId} ${noteId}`;

    const acts = document.createElement("div");
    acts.className = "acts";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    // Additiv wie bei den Hinweisknoepfen oben: die Rolle aus dem
    // Knopfsystem (Spec 11.2), die bisherige Klasse bleibt Vertrag.
    cancelButton.className = "host-confirm-btn btn btn--secondary btn--row";
    cancelButton.tabIndex = -1;
    cancelButton.dataset.focusKey = focusKey("confirm", host.id, "cancel");
    cancelButton.setAttribute("aria-describedby", describedBy);
    cancelButton.textContent = t("sidebar.confirmRemove.cancel");
    cancelButton.addEventListener("click", () => {
      if (!disposed) closeRemoveConfirm(host.id);
    });
    acts.appendChild(cancelButton);

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "host-confirm-btn host-confirm-btn-danger btn btn--danger btn--row";
    confirmButton.tabIndex = -1;
    confirmButton.dataset.focusKey = focusKey("confirm", host.id, "confirm");
    confirmButton.setAttribute("aria-describedby", describedBy);
    confirmButton.textContent = t("sidebar.confirmRemove.confirm");
    confirmButton.addEventListener("click", () => {
      if (disposed) return;
      const hostId = host.id;
      pendingRemoveHostId = null;
      render();
      if (!removalsInFlight.has(hostId)) {
        removalsInFlight.add(hostId);
        const finish = () => { removalsInFlight.delete(hostId); };
        void Promise.resolve(opts.onRemoveHost(hostId)).then(finish, finish);
      }
      // Persistence may finish later. Keep focus on the remaining host;
      // render() moves it to Add if this focused host is finally removed.
      const button = moreButtonFor(hostId);
      if (button) button.focus();
      else addButton.focus();
    });
    acts.appendChild(confirmButton);

    bar.appendChild(acts);

    // Am Streifen, nicht je Knopf. Er wird bei jedem Neuzeichnen mit
    // `list.replaceChildren()` verworfen -- anders als beim Menue (das
    // ausserhalb von `list` haengt) braucht es dafuer kein Abmelden.
    bar.addEventListener("keydown", (event) => {
      if (disposed) return;
      const buttons = Array.from(bar.querySelectorAll<HTMLElement>("button"));
      const current = buttons.indexOf(document.activeElement as HTMLElement);
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          // Nur die zwei Nachbarn, kein Roving-Modell dahinter: die Leiste
          // traegt keinen eigenen Tabstopp, es gibt also auch keine `0` zu
          // vergeben (anders als in Liste, Knopfleiste und Menue).
          if (current === -1) return;
          const step = event.key === "ArrowRight" ? 1 : buttons.length - 1;
          event.preventDefault();
          buttons[(current + step) % buttons.length].focus();
          return;
        }
        case "Escape":
          event.preventDefault();
          // MUSS die Weitergabe stoppen, aus demselben Grund wie im Menue:
          // main.ts haengt einen dauerhaften Dokument-Horcher, der eine
          // maximierte Kachel zurueckholt und diese Leiste nicht kennt.
          event.stopPropagation();
          closeRemoveConfirm(host.id);
          return;
        case "Tab":
          // KEIN preventDefault: der Tabulator soll weiterziehen. Wer die
          // Rueckfrage verlaesst, hat sie beantwortet -- mit "nein".
          closeRemoveConfirm(host.id);
          return;
      }
    });

    return bar;
  }

  // --- Kompakte Hinweise (UX-Spec §5.7) ---------------------------------
  //
  // Jeder Hinweisblock (Verbindung, Sessionliste, Steuerung) zeigt Titel,
  // hoechstens zwei Zeilen Meldung und seine Knoepfe; "Details" klappt die
  // volle Meldung und "Copy diagnostics" auf. Aufgeklappt ist reiner
  // Anzeigezustand wie `pendingKillKey` und muss das Neuzeichnen bei jeder
  // Zustandsaenderung ueberleben. Ein Hinweis, der verschwindet, faengt beim
  // naechsten Mal wieder zugeklappt an (`render()` raeumt auf).
  const expandedNotices = new Set<string>();
  const renderedNotices = new Set<string>();

  function noticeMessage(text: string): HTMLParagraphElement {
    const message = document.createElement("p");
    message.className = "host-notice-message";
    message.textContent = text;
    return message;
  }

  /** Haengt "Details" und das zunaechst verborgene "Copy diagnostics" HINTER
   * die Knoepfe des Hinweises: der erste Knopf bleibt dessen Hauptaktion.
   * `detail` ist Text, der erst aufgeklappt erscheint (der Rohtext des
   * Backends am Steuer- und am Listenhinweis, UX-Spec §10); er steht vor der
   * Knopfzeile.
   * Alles bleibt im DOM, nur `hidden` und die Klasse am Hinweis wechseln. */
  function appendNoticeDetails(
    notice: HTMLElement,
    acts: HTMLElement,
    spec: { host: Host; kind: string; copyFocusPart: string; diagnostics: () => string; detail?: string | null },
  ): void {
    const key = `${spec.host.id}:${spec.kind}`;
    renderedNotices.add(key);
    const expanded = expandedNotices.has(key);
    notice.classList.toggle("host-notice--expanded", expanded);

    let detail: HTMLParagraphElement | null = null;
    if (spec.detail) {
      detail = document.createElement("p");
      detail.className = "host-notice-detail";
      detail.textContent = spec.detail;
      detail.hidden = !expanded;
      notice.appendChild(detail);
    }

    const details = document.createElement("button");
    details.type = "button";
    // `host-notice-link` wie bei "Copy diagnostics": dieselbe Textrolle samt
    // Unterstreichung bei Hover.
    details.className = "host-notice-link host-notice-details btn btn--text btn--row";
    details.dataset.focusKey = focusKey("host", spec.host.id, `${spec.kind}Details`);
    details.setAttribute("aria-expanded", String(expanded));
    details.textContent = t("sidebar.notice.details");

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "host-notice-link btn btn--text btn--row";
    copy.dataset.focusKey = focusKey("host", spec.host.id, spec.copyFocusPart);
    copy.textContent = t("sidebar.notice.copyDiagnostics");
    copy.hidden = !expanded;
    copy.addEventListener("click", () => {
      // Best effort: jsdom (und manche echten Umgebungen) kennen
      // `navigator.clipboard` nicht von sich aus (siehe terminal.test.ts).
      if (disposed || !navigator.clipboard) return;
      void navigator.clipboard.writeText(spec.diagnostics()).catch(() => {});
    });

    // Am lebenden Knoten umgeschaltet statt neu gezeichnet: der Fokus bleibt
    // auf "Details", und die Menge traegt den Zustand ins naechste Neuzeichnen.
    details.addEventListener("click", () => {
      if (disposed) return;
      const open = !expandedNotices.has(key);
      if (open) expandedNotices.add(key);
      else expandedNotices.delete(key);
      notice.classList.toggle("host-notice--expanded", open);
      details.setAttribute("aria-expanded", String(open));
      copy.hidden = !open;
      if (detail) detail.hidden = !open;
    });
    acts.append(details, copy);
  }

  /** §11.2: Hinweisleiste bei nicht verbindbarem Host, mit `error`, "Retry"
   * (ruft denselben `onConnectHost`-Weg wie der Umschaltknopf auf) und
   * "Copy diagnostics". Der Fehlertext bleibt stehen, bis der Nutzer
   * handelt -- kein automatisches Ausblenden, kein `role=alert` (die
   * Seitenleiste zeichnet bei JEDER Zustandsaenderung neu, auch
   * Kachelfokus-Wechseln ausserhalb dieses Hosts; ein neu erzeugter
   * `role=alert`-Knoten wuerde bei jedem Neuzeichnen erneut vorgelesen). */
  function buildHostNotice(host: Host): HTMLElement {
    const notice = document.createElement("div");
    notice.className = "host-notice";

    const title = document.createElement("strong");
    title.textContent = t("sidebar.notice.title");
    notice.appendChild(title);
    notice.appendChild(noticeMessage(host.error ?? ""));

    // Abschlussreview (Important 1): OHNE dieses Feld war jeder erneute
    // Verbindungsversuch auf einen gespeicherten, PASSPHRASEGESCHUETZTEN
    // Schluessel eine Sackgasse -- `onConnectHost` reichte fest
    // `passphrase: null` durch, die Seitenleiste bot nur den Umschaltknopf,
    // und das Backend meldete jedes Mal `AuthError::PassphraseRequired`
    // ohne jede Eingabemoeglichkeit. Unter Windows 11 ist das der
    // NORMALFALL, nicht der Sonderfall: der ssh-agent-Dienst ist dort ab
    // Werk deaktiviert. Ein Plan-1-Commit hatte das in `host-list.ts`
    // bereits geschlossen; die Datei entfiel in Task 9, das Feld ging in
    // Task 11 mit den `hostList.*`-Schluesseln unbemerkt mit.
    //
    // Task 8 (Spec §4.8): welches Feld angeboten wird, entscheidet seither
    // `host.authKind` statt nur `host.keyPath` -- vorher gab es nur ZWEI
    // Faelle ("Schluessel gespeichert" -> Passphrasefeld, sonst nichts), und
    // ein per Passwort gespeicherter Host bekam ebenfalls nichts, obwohl
    // GENAU ER die Sackgasse dieser Aufgabe ist (`AuthError::PasswordWrong`
    // ohne jede Eingabemoeglichkeit).
    //
    // Gesamtreview M0 (Befund 1): das Passwortfeld gilt auch fuer
    // `authKind === "agent"`. Ein Host ohne gespeicherte Anmeldeart UND ohne
    // `key_path` wird von `effective_auth_kind()` (Rust) als "agent"
    // gemeldet -- das trifft jeden Host, der VOR Task 8 per Passwort
    // angelegt wurde, denn `auth_kind` existiert in seiner `settings.toml`
    // schlicht nicht. Ohne dieses Feld lief sein erneuter Verbindungsversuch
    // in dieselbe Sackgasse wie oben: nur die Agent-Fehlermeldung
    // ("ssh-agent not reachable ... Set-Service ssh-agent ..."), kein Weg
    // zum Passwort. Das Feld steht bewusst nur in der Hinweisleiste eines
    // GESCHEITERTEN Hosts, nicht dauerhaft an der Hostzeile: ein
    // echter ssh-agent-Host braucht hier weiterhin keine Eingabe, und
    // "Retry" ohne Eingabe versucht deshalb weiterhin zuerst den Agent
    // (siehe `onConnectHost` in main.ts). Dauerhaft behoben wird es durch
    // Bearbeiten des Hosts mit Auswahl "Passwort".
    //
    // Bewusst NICHT ueber das Neuzeichnen hinweg erhalten, SOLANGE das Feld
    // nicht fokussiert ist: `onConnectHost` setzt den Zustand auf
    // "connecting", die Leiste verschwindet dabei samt Feld, und ein
    // erneuter Fehlschlag baut sie LEER wieder auf. Steht der Fokus WEITERHIN
    // in diesem Feld (Befund 11 -- z. B. eine Zustandsaenderung an einem
    // ANDEREN Host loest ein Neuzeichnen aus, waehrend der Nutzer hier noch
    // tippt), ueberlebt der getippte Wert das Neuzeichnen (siehe `render()`s
    // Fokusrettung unten) -- er lebt aber weiterhin NUR im DOM, nie im
    // `AppState`: "nur im Arbeitsspeicher dieses einen Eingabefelds" ist so
    // am striktesten eingehalten, ohne dass diese Datei einen neuen,
    // dauerhafteren Zustand braucht (dieselbe Abwaegung wie `host-form.ts`s
    // Raeumen vor dem Verbindungsversuch).
    //
    // Das Feld steht nur nach einem Anmeldefehler (`asksForSecret`, gelesen
    // aus `host.errorCode`). Bei einem Netz-, Hostschluessel- oder sonstigen
    // Fehler hilft kein Geheimnis, und ein Feld daneben legte die Ursache
    // falsch nahe ("SSH connection timed out." mit Passphrasefeld). Dort
    // bleiben "Retry" und "Details", und `focusHostNotice` (main.ts) landet
    // auf "Retry".
    let credential: CredentialField | null = null;
    if (asksForSecret(host)) {
      if (host.authKind === "key" && host.keyPath) {
        credential = buildCredentialField({
          kind: "passphrase",
          focusKey: focusKey("host", host.id, "passphrase"),
        });
      } else if (host.authKind === "password" || host.authKind === "agent") {
        credential = buildCredentialField({
          kind: "password",
          focusKey: focusKey("host", host.id, "password"),
        });
      }
    }
    if (credential) notice.appendChild(credential.root);

    const acts = document.createElement("div");
    acts.className = "acts";

    const retryButton = document.createElement("button");
    retryButton.type = "button";
    // Knopfsystem ADDITIV zur bisherigen Klasse (Spec 11.2): `.btn`-Rolle
    // fuer die Optik, `host-notice-link` bleibt als Vertrag der Tests und
    // fuer die Geometrie der Hinweisleiste stehen.
    retryButton.className = "host-notice-link btn btn--secondary btn--row";
    retryButton.dataset.focusKey = focusKey("host", host.id, "retry");
    retryButton.textContent = t("sidebar.notice.retry");
    retryButton.addEventListener("click", () => {
      if (disposed) return;
      // Leeres Feld -> `undefined`, nicht `""`: ein leerer String waere auf
      // der Rust-Seite eine ANGEGEBENE (leere) Passphrase/Passwort, kein
      // Weglassen. Hoechstens EINES der beiden Felder existiert je Host
      // (siehe Verzweigung oben), die beiden Zweige schliessen sich deshalb
      // gegenseitig aus.
      const typed = credential?.value();
      if (credential && typed !== undefined) {
        opts.onConnectHost(
          host.id,
          credential.kind === "passphrase" ? { passphrase: typed } : { password: typed },
        );
      } else {
        opts.onConnectHost(host.id, undefined);
      }
    });
    acts.appendChild(retryButton);
    appendNoticeDetails(notice, acts, {
      host, kind: "connection", copyFocusPart: "copyDiagnostics",
      diagnostics: () => `${appVersionLine()}\n${host.error ?? ""}`,
    });

    notice.appendChild(acts);
    return notice;
  }

  /** UX-Spec §5.3, §5.4, §5.7: waehrend der Selbstreparatur und waehrend des
   * Neuverbindens steht unter der Hostzeile nur eine ruhige Zeile --
   * gedaempfter Text mit Drehsymbol, ohne Rahmen und ohne Knopf; Kacheln und
   * Statuspillen ("As of") sagen den Rest. Kein `role=status`, aus demselben
   * Grund wie in `buildHostNotice`:
   * ein bei jedem Neuzeichnen neu erzeugter Live-Bereich wuerde jedes Mal
   * erneut angesagt. Das Drehsymbol ist die Form von "Connecting" in der
   * Farbe der Zeile, samt ihrer Fassung fuer reduzierte Bewegung. */
  function buildQuietLine(className: string, text: string): HTMLElement {
    const line = document.createElement("p");
    line.className = className;
    const spinner = document.createElement("span");
    spinner.className = "ind ind-connecting";
    spinner.setAttribute("aria-hidden", "true");
    line.append(spinner, document.createTextNode(text));
    return line;
  }

  function buildControlQuietLine(): HTMLElement {
    return buildQuietLine("control-quiet", t("control.reconnecting"));
  }

  function buildControlNotice(host: Host): HTMLElement | null {
    const control = state.controlForHost(host.id);
    if (host.state !== "connected" || control.state === "ready") return null;
    if (state.isControlSelfRepairing(host.id)) return buildControlQuietLine();
    const notice = document.createElement("div");
    notice.className = "host-notice control-notice";
    const title = document.createElement("strong");
    title.textContent = t(control.state === "reconnecting" ? "control.reconnecting" : "control.unavailable");
    notice.appendChild(title);
    // UX-Spec §10: "Was ist passiert. Was tun." traegt den Kasten; der Rohtext
    // des Backends steht nur hinter "Details" und in "Copy diagnostics".
    notice.appendChild(noticeMessage(t("control.explanation")));
    // Ein offenes Formular bringt Absenden und Abbrechen selbst mit.
    const editor = controlEditors.get(host.id);
    if (editor) notice.appendChild(editor.root);
    const acts = document.createElement("div");
    acts.className = "acts";
    if (!editor && (control.state === "degraded" || control.state === "authentication_required") && opts.onRepairControl) {
      const repair = document.createElement("button");
      repair.type = "button";
      repair.className = "btn btn--secondary btn--row";
      repair.dataset.focusKey = focusKey("host", host.id, "repairControl");
      repair.textContent = t("control.repairSubmit");
      repair.addEventListener("click", () => { if (!disposed) openControlEditor(host); });
      acts.appendChild(repair);
    } else if (!editor && control.state === "reconnecting" && opts.onCancelControlRepair) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn--secondary btn--row";
      cancel.dataset.focusKey = focusKey("host", host.id, "cancelControlRepair");
      cancel.textContent = t("control.cancel");
      cancel.addEventListener("click", () => { if (!disposed) opts.onCancelControlRepair?.(host.id); });
      acts.appendChild(cancel);
    }
    appendNoticeDetails(notice, acts, {
      host, kind: "control", copyFocusPart: "controlDiagnostics", detail: control.message,
      diagnostics: () => [appVersionLine(), control.state, control.message].filter(Boolean).join("\n"),
    });
    notice.appendChild(acts);
    return notice;
  }

  function buildSessionListNotice(host: Host): HTMLElement | null {
    const observation = state.sessionListForHost(host.id);
    if (host.state !== "connected") return null;
    // UX-Spec §5.3, §5.7: solange die Steuerung nicht bereit ist, sagt ihre
    // ruhige Zeile bzw. ihr Kasten schon, dass die Liste nicht nachkommt. Ein
    // Listenfehler, der nur das meldet, bekommt keinen eigenen Kasten; es gilt,
    // was ohne Fehler gaelte.
    const error = observation.error?.code === "control_unavailable" &&
      state.controlForHost(host.id).state !== "ready" ? null : observation.error;
    if (!error) {
      if (!host.expanded || (observation.status === "current" && host.sessions.length > 0)) return null;
      // Waehrend der Selbstreparatur und einer laufenden Reparatur traegt die
      // Steuerzeile den Zustand allein. Der Satz "...for this connection" passte
      // ohnehin nicht: die Verbindung ist dieselbe, nur die Steuerung fehlt.
      if (state.isControlSelfRepairing(host.id) || state.controlForHost(host.id).state === "reconnecting") return null;
      const hint = document.createElement("p");
      hint.className = "sb-empty-hint session-list-hint";
      hint.textContent = observation.status === "never_loaded"
        ? t("sidebar.sessions.notLoaded")
        : observation.status === "stale" ? t("sidebar.sessions.notRefreshed") : t("sidebar.sessions.empty");
      return hint;
    }

    const notice = document.createElement("div");
    notice.className = "host-notice session-list-notice";
    const heading = document.createElement("strong");
    heading.textContent = observation.status === "never_loaded"
      ? t("sidebar.sessions.unavailable") : t("sidebar.sessions.stale");
    notice.appendChild(heading);
    // UX-Spec §10: der Satz traegt den Kasten, der Rohtext des Backends steht
    // nur hinter "Details" und in "Copy diagnostics" -- wie am Steuerhinweis.
    notice.appendChild(noticeMessage(t("sidebar.sessions.loadFailed")));
    if (observation.lastSuccessAt !== null) {
      const time = document.createElement("time");
      time.dateTime = new Date(observation.lastSuccessAt).toISOString();
      time.textContent = t("sidebar.sessions.lastSuccess", { time: new Date(observation.lastSuccessAt).toLocaleString() });
      notice.appendChild(time);
    }

    const actions = document.createElement("div");
    actions.className = "acts";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "host-notice-link btn btn--secondary btn--row";
    retry.dataset.focusKey = focusKey("host", host.id, "sessionListRetry");
    retry.textContent = t("sidebar.notice.retry");
    retry.addEventListener("click", () => { if (!disposed) opts.onReloadSessions(host.id); });
    actions.appendChild(retry);
    appendNoticeDetails(notice, actions, {
      host, kind: "sessionList", copyFocusPart: "sessionListDiagnostics", detail: error.message,
      diagnostics: () => [appVersionLine(), error.code, error.message].filter(Boolean).join("\n"),
    });
    notice.appendChild(actions);
    return notice;
  }

  /** Host-qualifiziert ueber `sessionKey()` (nicht per Namensvergleich) --
   * genau die Absicherung, die im Aufgabentext gefordert ist: zwei Hosts
   * duerfen gleichnamige Sessions tragen, ein Klick muss den EIGENEN Host
   * melden. */
  function buildSessionRow(host: Host, session: Session): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "sb-session-row";

    const row = document.createElement("button");
    row.type = "button";
    row.className = "ab-row row-session";
    // UNBEDINGT `-1`; `applyListRoving` ist der einzige Schreiber der `0`.
    // Zwei Schreiber desselben Attributs waeren eine Frage der
    // Aufrufreihenfolge, und die verliert man.
    row.tabIndex = -1;
    const key = sessionKeyOf(session);
    row.dataset.sessionKey = key;
    row.dataset.focusKey = focusKey("session", key, "row");

    // Aufgabe 8: Form links im 14er-Kasten (rechtsbuendig unter dem
    // Kuerzelquadrat, Spec 7.4), Wort rechts im Meta-Feld als zweiter Platz
    // nach dem Agentenplatz (Spec 7.6, bis M1 nicht gerendert).
    const { cls, label: stateLabel } = sessionIndicator(session, isReconnecting(host));
    const indBox = document.createElement("span");
    indBox.className = "ind-box icon-box icon-box--sm";
    indBox.setAttribute("aria-hidden", "true");
    // Spec 2026-10-19 §7: steht die Session in einer Kachel, zeigt der Kasten
    // deren Nummer statt des Punkts. Das Warndreieck eines gesperrten Kanals
    // geht vor -- es sagt, was zu tun ist.
    const tile = state.tileForSession(key);
    const position = tile ? state.tilePosition(tile.id) : null;
    if (tile && position !== null && !cls.includes("ind-warn")) {
      indBox.appendChild(buildTileNumber(position + 1, state.focusedTile === tile.id));
    } else {
      const ind = document.createElement("span");
      ind.className = cls;
      indBox.appendChild(ind);
    }
    row.appendChild(indBox);

    // Spec 2026-10-19 §5.2: der Tooltip sagt, was Klick und Strg+Klick tun.
    const hint = t(tile ? "sidebar.session.hintOpen" : "sidebar.session.hintClosed");

    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = session.name;
    // Task 16, Punkt B: die Leiste ist schmal, `.row-label` kuerzt mit
    // Ellipse -- der native Tooltip macht den vollen Namen wieder lesbar
    // (v1 §9 Nr. 11 erlaubt `title` ausdruecklich). Der Name deckt den
    // groessten Teil der Zeile, und sein eigener `title` verdeckt den der
    // Zeile: darum steht der Hinweis auch hier, hinter dem vollen Namen.
    label.title = `${session.name}\n${hint}`;
    row.appendChild(label);

    const meta = document.createElement("span");
    meta.className = "row-meta";
    // UI v2 7.6, M1.2: der Agentenplatz. Mit Statusdaten traegt die Pille die
    // Aussage; das Kanalwort bleibt fuer Screenreader im Text und wandert fuer
    // die Maus in den Tooltip der Zeile -- in 240 px blieben dem Sessionnamen
    // neben Pille UND Kanalwort sonst rund sieben Zeichen.
    const view = agentStatusView(
      session.status,
      session.statusReason,
      state.isSessionStatusCurrent(host.id, session.name, socketOf(session)),
      state.sessionStatusObservedAt(host.id, session.name, socketOf(session)),
    );
    if (view) meta.appendChild(buildStatusPill(view));
    const word = document.createElement("span");
    word.className = view ? "row-state-word ab-visually-hidden" : "row-state-word";
    word.textContent = stateLabel;
    meta.appendChild(word);
    // Mit Statuspille steht vor dem Hinweis das Kanalwort, das dann nur hier steht.
    row.title = view ? `${stateLabel}\n${hint}` : hint;
    row.appendChild(meta);

    // Spec 7.4: die Session der fokussierten Kachel ist "ausgewaehlt" --
    // dasselbe Attribut, das grid.ts an der Kachel setzt.
    const focusedKey = state.focusedSessionKey();
    if (focusedKey === key) row.setAttribute("aria-current", "true");

    // Ein Klick oeffnet ODER holt in den Fokus; mit Strg ersetzt er die
    // fokussierte Kachel (Spec 2026-10-19 §5.1, §5.2). Beides laeuft ueber
    // denselben Aufruf -- `AppState` (nicht Teil dieser Datei) entscheidet
    // ueber die Kachelzuordnung, ob das eine neue Zuweisung, ein Ersetzen oder
    // ein blosser Fokuswechsel ist.
    row.addEventListener("click", (event) => {
      if (!disposed) opts.onOpenSession(host.id, session.name, openOptions(event.ctrlKey, session));
    });
    wrap.appendChild(row);

    // Task 16, Punkt A: die zwei Aktionen liegen seither in EINEM Behaelter
    // rechts IN der Zeile (absolut gesetzt, siehe styles.css) statt als
    // Geschwister neben ihr. Unbedingt angehaengt, auch wenn er leer bleibt
    // (getrennter Host, geschlossene Session): eine Bedingung mehr spart hier
    // ein leeres, unsichtbares `<span>` und kostet eine Sonderregel in jeder
    // Suche darunter.
    const acts = document.createElement("span");
    acts.className = "session-acts";
    wrap.appendChild(acts);

    if (session.open) {
      const closeButton = buildActionButton(
        t("sidebar.action.closeSession"),
        focusKey("session", key, "close"),
        () => opts.onCloseSession(host.id, session.name, socketOf(session)),
        // `session-close-btn` bleibt der Vertrag der Tastaturverdrahtung und
        // der Tests; die Rolle aus dem Knopfsystem setzt `buildActionButton`
        // fuer Icon-Knoepfe selbst (`btn btn--text btn--row`).
        "session-close-btn",
        "x",
      );
      // Entwurf §3.2: er bleibt mit der Tastatur bedienbar, aber NICHT als
      // eigener Tabulatorhalt -- je offener Session waere das sonst einer
      // mehr. Erreichbar mit `→` auf der Sessionzeile, `←` fuehrt zurueck.
      closeButton.tabIndex = -1;
      // Der Tooltip bleibt der blosse Name (`buildActionButton`): Strg+Umschalt+W
      // schliesst die fokussierte Kachel, nicht die Session dieser Zeile (UX-Spec
      // §8.4).
      acts.appendChild(closeButton);
    }

    // UNABHAENGIG von `session.open`, und das ist der Punkt: die verwaisten
    // Sessions, um die es hier geht, sind nie offen -- genau sie soll man
    // loswerden koennen. Bis zu diesem Paket gab es aus der Anwendung
    // heraus ueberhaupt keinen Weg, eine angelegte Session je wieder zu
    // beenden.
    //
    // ABER NUR bei verbundenem Host: `kill_session` braucht die Laufzeit-ID.
    // Ohne diese Wache stuende der Knopf auch an einer Sessionzeile eines
    // GETRENNTEN Hosts (`onDisconnectHost` leert `host.sessions` nicht) --
    // der Nutzer laese dort "This cannot be undone", bestaetigte, und
    // bekaeme als Antwort einen Satz ueber das OEFFNEN einer Session
    // (`session.hostNotConnected`). Er wuesste danach nicht, ob die Sitzung
    // noch laeuft.
    //
    // HINTEN, nach dem Schliessknopf: `→` von der Zeile aus darf nicht
    // zuerst auf dem zerstoererischen Knopf landen. (Bei einer geschlossenen
    // Session ist er der einzige und damit unvermeidlich der erste -- die
    // Rueckfrage traegt dort die ganze Last.)
    if (host.state !== "connected") return wrap;

    const killButton = buildActionButton(
      t("sidebar.action.killSession"),
      focusKey("session", key, "kill"),
      () => {
        if (disposed) return;
        // Nur die Rueckfrage oeffnen. Das Beenden selbst haengt an ihrem
        // Bestaetigungsknopf -- dieselbe Zurueckhaltung wie beim Entfernen
        // eines Hosts.
        pendingKillKey = key;
        render();
        focusByKey(focusKey("confirm", key, "cancel"));
      },
      "session-kill-btn",
      "trash-2",
    );
    killButton.tabIndex = -1;
    acts.appendChild(killButton);

    if (pendingKillKey === key) {
      wrap.appendChild(buildKillConfirm(host, session));
    }

    return wrap;
  }

  /** Rueckfrage vor dem Beenden -- gebaut wie `buildRemoveConfirm`, mit
   * derselben Begruendung fuer `aria-describedby` und `tabindex="-1"` (siehe
   * dort; sie wird hier nicht wiederholt).
   *
   * Der Satz muss sagen, was WIRKLICH passiert: die Sitzung und alles, was
   * darin laeuft, wird beendet. "Close terminal" daneben schliesst
   * ausdruecklich nur die Ansicht -- stuenden beide Aktionen mit aehnlichem
   * Text nebeneinander, waere die zerstoererische die missverstaendliche. */
  function buildKillConfirm(host: Host, session: Session): HTMLElement {
    const key = sessionKeyOf(session);
    const bar = document.createElement("div");
    bar.className = "host-confirm-remove session-confirm-kill";

    // FESTE Kennungen, ohne den Schluessel darin -- und das ist kein Stil,
    // sondern der Unterschied zwischen wirksam und wirkungslos:
    // `aria-describedby` ist eine LEERZEICHENGETRENNTE ID-Liste, und ein
    // Sessionname DARF seit B2 Leerzeichen enthalten. Mit `ab-kill-q-h1/deploy
    // log 2` zerfiele die Liste in sechs Bruchstuecke, von denen keines
    // aufloest -- der Screenreader saegte beim Fokussprung nur "Cancel,
    // Schaltflaeche", und der Satz "This cannot be undone" kaeme nie an.
    // Genau bei den Namen also, die dieses Paket erst moeglich macht.
    //
    // `buildRemoveConfirm` daneben darf `host.id` einsetzen, weil dessen
    // Format (`host_<hex>`) kein Leerzeichen enthalten KANN -- die dortige
    // Begruendung traegt hier gerade nicht. Feste Kennungen gehen, weil
    // gleichzeitig ohnehin nur EINE Rueckfrage offen steht (`pendingKillKey`
    // ist ein einzelner Wert).
    const questionId = "ab-kill-q";
    const noteId = "ab-kill-n";

    const question = document.createElement("strong");
    question.id = questionId;
    question.textContent = t("sidebar.confirmKill.question", { name: session.name });
    bar.appendChild(question);

    const note = document.createElement("span");
    note.id = noteId;
    note.textContent = t("sidebar.confirmKill.note");
    bar.appendChild(note);
    const describedBy = `${questionId} ${noteId}`;

    const confirmActs = document.createElement("div");
    confirmActs.className = "acts";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "host-confirm-btn btn btn--secondary btn--row";
    cancelButton.tabIndex = -1;
    cancelButton.dataset.focusKey = focusKey("confirm", key, "cancel");
    cancelButton.setAttribute("aria-describedby", describedBy);
    cancelButton.textContent = t("sidebar.confirmKill.cancel");
    cancelButton.addEventListener("click", () => {
      if (!disposed) closeKillConfirm(key);
    });
    confirmActs.appendChild(cancelButton);

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "host-confirm-btn host-confirm-btn-danger btn btn--danger btn--row";
    confirmButton.tabIndex = -1;
    confirmButton.dataset.focusKey = focusKey("confirm", key, "confirm");
    confirmButton.setAttribute("aria-describedby", describedBy);
    confirmButton.textContent = t("sidebar.confirmKill.confirm");
    confirmButton.addEventListener("click", () => {
      if (disposed) return;
      pendingKillKey = null;
      opts.onKillSession(host.id, session.name, socketOf(session));
      // Der Fokus geht gleich auf die HOSTZEILE, nicht auf die Sessionzeile.
      // Die waere zwar im Moment der Rueckkehr noch da -- `onKillSession` ist
      // asynchron --, verschwindet aber, sobald die frische Sessionliste
      // eintrifft; erst dann fiele `render()`s Fokusrettung auf die Hostzeile
      // zurueck (Fixrunde 3). Die Hostzeile ueberlebt beide Schritte.
      render();
      focusByKey(focusKey("host", host.id, "row"));
    });
    confirmActs.appendChild(confirmButton);

    bar.appendChild(confirmActs);

    // Dasselbe Zwei-Nachbarn-Modell wie in `buildRemoveConfirm`, aus
    // derselben Begruendung: die Leiste traegt keinen eigenen Tabstopp.
    bar.addEventListener("keydown", (event) => {
      if (disposed) return;
      const buttons = Array.from(bar.querySelectorAll<HTMLElement>("button"));
      const current = buttons.indexOf(document.activeElement as HTMLElement);
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (current === -1) return;
        event.preventDefault();
        const next = event.key === "ArrowRight" ? current + 1 : current - 1;
        buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        // MUSS die Weitergabe stoppen, aus demselben Grund wie oben:
        // main.ts haengt einen dauerhaften Dokument-Horcher, der eine
        // maximierte Kachel zurueckholt und diese Leiste nicht kennt.
        event.stopPropagation();
        closeKillConfirm(key);
        return;
      }
      if (event.key === "Tab") {
        // KEIN preventDefault: der Tabulator soll weiterziehen. Wer die
        // Rueckfrage verlaesst, hat sie beantwortet -- mit "nein". Ohne
        // diesen Zweig bliebe sie stehen, waere aber unbeantwortbar: beide
        // Knoepfe tragen `tabindex="-1"`, der Fokus kaeme nicht zurueck, und
        // der Escape-Horcher haengt an dieser Leiste.
        pendingKillKey = null;
        render();
      }
    });

    return bar;
  }

  /** UX-Spec §5.4: verbindet die App diesen Host gerade selbst neu? */
  function isReconnecting(host: Host): boolean {
    return host.state !== "connected" && state.isHostReconnecting(host.id);
  }

  function buildHostBlock(host: Host): HTMLElement {
    const block = document.createElement("div");
    block.className = "sb-host-block";

    const row = document.createElement("button");
    row.type = "button";
    row.className = "ab-row row-host";
    // UNBEDINGT `-1`, siehe `buildSessionRow`.
    row.tabIndex = -1;
    row.dataset.hostId = host.id;
    row.dataset.focusKey = focusKey("host", host.id, "row");
    row.setAttribute("aria-expanded", String(host.expanded));
    // Spec 7.3: der Zustand steht als Datenattribut an der ZEILE, damit
    // `styles.css` die Zeile als Ganzes danach faerben kann -- die Pille
    // unten traegt denselben Zustand ein zweites Mal, weil sie ihn als Wort
    // ausspricht. Kein dritter Speicherort: beide lesen `host.state`.
    row.dataset.state = host.state;

    const chev = document.createElement("span");
    chev.className = "chev icon-box";
    chev.setAttribute("aria-hidden", "true");
    // Der Name steht zusaetzlich als Datenattribut da: das SVG selbst traegt
    // keinen lesbaren Hinweis darauf, welches Icon es ist (nur Pfade), und
    // der Aufklappzustand soll pruefbar bleiben, ohne Pfaddaten zu
    // vergleichen.
    const chevName = host.expanded ? "chevron-down" : "chevron-right";
    chev.dataset.icon = chevName;
    chev.appendChild(icon(chevName));
    row.appendChild(chev);

    // Kuerzelquadrat: nur Identitaet, in allen Zustaenden gleich (Spec 7.3).
    // `aria-hidden`, weil es den Namen daneben bloss abkuerzt -- vorgelesen
    // waere es eine zweite, kryptische Ansage desselben Hosts.
    const avatar = document.createElement("span");
    avatar.className = "sb-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = hostInitials(host.label, host.hostname);
    row.appendChild(avatar);

    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = host.label;
    // Task 16, Punkt B, wie an der Sessionzeile: gerade IP-Adressen wurden
    // neben der Zustandspille abgeschnitten.
    label.title = host.label;
    row.appendChild(label);

    const meta = document.createElement("span");
    meta.className = "row-meta";
    // Designsystem 5.2: "Eine zugeklappte Gruppe zeigt rechts `7 sessions`".
    // NUR zugeklappt -- aufgeklappt stehen die Sessions darunter, die Zahl
    // waere dort Rauschen. Und nicht bei null: "0 sessions" fuellt eine
    // Stelle mit einem Wort, ohne etwas zu sagen; ein Host ohne Sessions
    // zeigt schlicht nichts.
    //
    // UX-Spec §7.8: wartet dort jemand, steht statt der Zahl eine Waiting-Pille
    // mit der Zahl der Wartenden, gebaut wie die Statuspille. Gezaehlt nach der
    // Regel von Fenstertitel und Schnelloeffnen (`waitingSessions`, nur ein
    // aktueller, nicht veralteter `waiting`-Status) -- keine zweite Zaehlweise.
    const count = host.sessions.length;
    const waiting = host.expanded
      ? 0
      : waitingSessions([host], (h, s) => state.isSessionStatusCurrent(h.id, s.name, socketOf(s))).length;
    const reconnecting = isReconnecting(host);
    if (waiting > 0) {
      // Aufgabe 19, Fixrunde 1: die Waiting-Pille tritt
      // auch an die Stelle der Zustandspille. Ein aktueller Wartestatus setzt
      // eine lebende Verbindung voraus ("Online"), und neben beiden Pillen
      // bliebe dem Hostnamen bei 240 px kaum Platz. Den Zustand traegt die
      // Zeile weiter in `data-state`.
      const word = t("sidebar.host.waitingCount", { count: String(waiting) });
      meta.appendChild(buildStatusPill({ kind: "waiting", shape: "waiting", word, title: word }));
    } else {
      if (!host.expanded && count > 0) {
        const countEl = document.createElement("span");
        countEl.className = "row-session-count";
        countEl.textContent =
          count === 1
            ? t("sidebar.host.sessionCountOne")
            : t("sidebar.host.sessionCount", { count: String(count) });
        meta.appendChild(countEl);
      }
      // Spec 7.3: Form und Wort stehen seit UI v2 zusammen in einer Pille --
      // dieselben zwei Kanaele wie zuvor (`appendIndicator` schreibt beide),
      // nur mit einer eigenen Flaeche darum. Die Klasse traegt den Zustand
      // mit, damit die Fuellung der Pille ohne einen zweiten Schalter in
      // `styles.css` je Zustand anders ausfallen kann.
      //
      // UX-Spec §5.4: waehrend des Neuverbindens steht zwischen zwei Versuchen
      // "Offline" statt des roten "Failed" -- die ruhige Zeile darunter sagt,
      // dass die App es selbst wieder versucht.
      const pillState: HostState = reconnecting && host.state === "failed" ? "disconnected" : host.state;
      const { cls, label: stateLabel } = hostIndicator(pillState);
      const pill = document.createElement("span");
      pill.className = `state-pill state-pill--${pillState}`;
      appendIndicator(pill, cls, stateLabel);
      meta.appendChild(pill);
    }
    row.appendChild(meta);

    row.addEventListener("click", () => {
      // Ueber AppState, siehe Kopfkommentar; neu gezeichnet wird aus der
      // Benachrichtigung.
      state.setHostExpanded(host.id, !host.expanded);
    });
    block.appendChild(row);

    block.appendChild(buildHostActions(host));

    // ZWISCHEN Knopfleiste und Hinweisleiste: die Rueckfrage gehoert zu der
    // Aktion, die man gerade ausgeloest hat, die Hinweisleiste zum Zustand
    // des Hosts. Ein fehlgeschlagener Host ist ein plausibler Kandidat fuers
    // Entfernen -- beide koennen also gleichzeitig stehen, und dann steht
    // die Frage oben.
    if (pendingRemoveHostId === host.id) {
      block.appendChild(buildRemoveConfirm(host));
    }

    // UX-Spec §5.4, §5.7: waehrend der Reihe nur die ruhige Zeile, kein
    // Kasten. Nach ihrem Ende (fuenfter Fehlschlag, Anmelde- oder
    // Hostschluesselfehler) steht wieder der Kasten mit "Retry".
    if (reconnecting) {
      block.appendChild(buildQuietLine("host-quiet", t("sidebar.state.reconnecting")));
    } else if (host.state === "failed") {
      block.appendChild(buildHostNotice(host));
    }
    const listNotice = buildSessionListNotice(host);
    if (listNotice) block.appendChild(listNotice);
    const controlNotice = buildControlNotice(host);
    if (controlNotice) block.appendChild(controlNotice);

    if (host.expanded) {
      for (const session of host.sessions) {
        block.appendChild(buildSessionRow(host, session));
      }
    }

    return block;
  }

  // --- Roving in der Liste (Entwurf §3) --------------------------------
  //
  // Der ZEIGER ist ein `data-focus-key`-WERT, keine Elementreferenz -- die
  // ueberlebt `list.replaceChildren()` nicht.
  //
  // Zeiger und Fokusrettung sind ZWEI Dinge mit VERSCHIEDENER Regel, wenn
  // ihr Ziel verschwindet: die Rettung faellt dann nur auf die Hostzeile
  // DESSELBEN Hosts zurueck und fokussiert sonst NICHTS (ein geratener
  // Nachbar waere eine stille Fehlbedienungsquelle, mit "Remove" in
  // Reichweite), der Zeiger MUSS dagegen auf irgendeinen Ueberlebenden
  // fallen, sonst hat die Liste gar keinen Tabstopp mehr. Wer beide zu einer
  // Variablen zusammenzieht, bricht genau eine der zwei Zusicherungen.
  let rovingKey: string | null = null;

  /** Einziger Schreiber von `rovingKey` -- und damit die eine Stelle, an der
   * ein Wechsel des BESITZENDEN Hosts ueberhaupt bemerkbar ist. Ein
   * Vorher/Nachher-Vergleich innerhalb von `applyListRoving` taete es nicht:
   * `moveListTo` und der `focusin`-Abgleich setzen den Zeiger, BEVOR sie
   * dorthin verzweigen -- gerade in den zwei Wegen, die den Host wirklich
   * wechseln, saehe der Vergleich also keinen Unterschied. */
  function setRovingKey(next: string | null): void {
    const previousHostId = owningHostId();
    rovingKey = next;
    // Die Markierung des aktiven Hosts haengt am Zeiger, also hier neu
    // gesetzt: ein `render()` allein genuegte nicht -- Pfeiltasten und der
    // `focusin`-Abgleich bewegen den Zeiger OHNE Neuzeichnen, die Markierung
    // bliebe dann am vorigen Host stehen.
    applyActiveHostClass();
    // Gemerkt wird nur der Platz INNERHALB einer Leiste, nie der Host (den
    // leitet `owningHostId()` jedes Mal neu ab). Wechselt er, faengt die
    // neue Leiste wieder beim ersten Knopf an -- ihre Knoepfe sind andere.
    if (owningHostId() !== previousHostId) toolbarIndex = 0;
  }

  /** Die navigierbaren Eintraege der Liste in Dokumentreihenfolge: Hostzeilen
   * und, bei aufgeklapptem Host, dessen Sessionzeilen. AUS DEM DOM abgeleitet
   * und nicht aus `state.hosts` nachgebaut -- `buildHostBlock` entscheidet
   * bereits, welche Zeilen gezeichnet werden, und eine zweite Definition
   * derselben Regel muesste man synchron halten. */
  function listEntries(): HTMLElement[] {
    return Array.from(list.querySelectorAll<HTMLElement>(".ab-row"));
  }

  /** Einziger Schreiber von `tabindex="0"` in der Liste -- die Zeilen selbst
   * werden unbedingt mit `-1` gebaut (dieselbe Regel wie im Menue). */
  function applyListRoving(takeFocus: boolean): void {
    const entries = listEntries();
    if (entries.length === 0) { setRovingKey(null); return; }
    let index = entries.findIndex((e) => e.dataset.focusKey === rovingKey);
    // Unbekannter Zeiger: die erste Hostzeile, nicht die erste Zeile der
    // Wartet-Spur -- sonst laege der Halt der Knopfleiste in der Spur.
    if (index === -1) index = Math.max(0, entries.findIndex((e) => e.classList.contains("row-host")));
    entries.forEach((e, i) => { e.tabIndex = i === index ? 0 : -1; });
    setRovingKey(entries[index].dataset.focusKey ?? null);
    // Der Halt der Knopfleiste ist ABGELEITET, also wird er bei JEDER
    // Zeigerbewegung neu vergeben. Hier statt an den drei Aufrufstellen:
    // `moveListTo`, der `focusin`-Abgleich und `render()` laufen alle hier
    // durch -- drei Aufrufe waeren dieselbe Regel dreimal.
    applyToolbarRoving(false);
    if (takeFocus) entries[index].focus();
  }

  function moveListTo(index: number): void {
    const entries = listEntries();
    if (entries.length === 0) return;
    const clamped = Math.max(0, Math.min(entries.length - 1, index));
    setRovingKey(entries[clamped].dataset.focusKey ?? null);
    applyListRoving(true);
  }

  /** Der Host zu einer HOSTZEILE, `null` bei einer Sessionzeile. Ueber
   * `data-host-id` unterschieden, das allein `buildHostBlock` setzt. */
  function hostOfRow(row: HTMLElement): Host | null {
    const hostId = row.dataset.hostId;
    if (hostId === undefined) return null;
    return state.hosts.find((h) => h.id === hostId) ?? null;
  }

  // EINMAL an `list`, nicht je Zeile: `list` ueberlebt jedes Neuzeichnen
  // (nur seine Kinder werden ersetzt), also braucht es kein Abraeumen je
  // Zeile. Navigiert ueber die Eintraegeliste, nie ueber `event.target`.
  list.addEventListener("keydown", (event) => {
    if (disposed) return;
    const entries = listEntries();
    const active = document.activeElement;

    const current = active instanceof HTMLElement ? entries.indexOf(active) : -1;
    if (current === -1) {
      // Der Fokus steckt in einem Knopf, nicht in einer Zeile. Die Knoepfe
      // der Sessionzeile gehoeren trotzdem hierher: `→` von der Zeile aus
      // erreicht sie, und ohne Rueckweg waeren sie eine Sackgasse.
      // Knopfleiste und Hinweisleiste gehen die Liste nichts an.
      //
      // Seit B3 sind es ZWEI Knoepfe (Schliessen und Beenden), und bei einer
      // geschlossenen Session nur einer -- deshalb ein Modell statt einer
      // festen Verdrahtung auf `.session-close-btn`: `→` geht zum naechsten
      // Knopf, `←` zum vorigen und vom ersten zurueck in die Zeile.
      //
      // Ueber `.session-acts` abgegrenzt, nicht mehr ueber die Klasse
      // `host-action-btn` (Task 16, Punkt A: die Icon-Knoepfe tragen sie
      // nicht mehr). Die Abgrenzung MUSS bleiben: die Beenden-Rueckfrage ist
      // ebenfalls ein Kind von `.sb-session-row` und bringt zwei eigene
      // Knoepfe mit, die ihr eigenes Zwei-Nachbarn-Modell haben.
      if (!(active instanceof HTMLElement)) return;
      const rowWrap = active.closest(".sb-session-row");
      const actsWrap = active.closest(".session-acts");
      if (!rowWrap || !actsWrap) return;
      const buttons = Array.from(actsWrap.querySelectorAll<HTMLElement>("button"));
      const at = buttons.indexOf(active);
      if (at === -1) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        buttons[at + 1]?.focus();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (at === 0) rowWrap.querySelector<HTMLElement>(".ab-row")?.focus();
        else buttons[at - 1]?.focus();
      }
      return;
    }
    const row = entries[current];
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); moveListTo(current + 1); return;
      case "ArrowUp": event.preventDefault(); moveListTo(current - 1); return;
      case "Home": event.preventDefault(); moveListTo(0); return;
      case "End": event.preventDefault(); moveListTo(entries.length - 1); return;
      case "ArrowRight": {
        event.preventDefault();
        const host = hostOfRow(row);
        if (host === null) {
          // Sessionzeile: hinein heisst in den ERSTEN Knopf.
          //
          // Bei einer OFFENEN Session ist das "Close terminal": der
          // zerstoererische steht hinter ihm, `→` landet nicht zuerst auf
          // ihm. Bei einer geschlossenen ist "End session…" der einzige und
          // damit unvermeidlich der erste -- die Reihenfolge kann dort
          // nichts ausrichten, die Last traegt allein die Rueckfrage. Der
          // frueher hier stehende Satz behauptete die Zusage fuer beide
          // Faelle; sie gilt nur fuer den ersten.
          // Hier braucht es KEINEN Umweg ueber `focusSessionAction`: die
          // Zeile hat den Fokus, `:focus-within` steht also schon, und die
          // Aktionen sind sichtbar.
          row.closest(".sb-session-row")
            ?.querySelector<HTMLElement>(".session-acts button")
            ?.focus();
        } else if (!host.expanded) {
          // Wie im Klickbehandler: ueber AppState, neu gezeichnet wird aus
          // der Benachrichtigung.
          state.setHostExpanded(host.id, true);
        } else if (entries[current + 1]?.classList.contains("row-session")) {
          // Die Dokumentreihenfolge buergt fuer die Zugehoerigkeit: der
          // Eintrag direkt nach einer Hostzeile ist deren erste Session.
          // Ein aufgeklappter Host OHNE Sessions faellt damit von selbst
          // auf "nichts tun" -- der naechste Eintrag ist dann eine
          // Hostzeile, und dorthin steigt man nicht "hinein".
          moveListTo(current + 1);
        }
        return;
      }
      case "ArrowLeft": {
        event.preventDefault();
        const host = hostOfRow(row);
        // Auf einer SESSIONZEILE tut `←` nichts: die Tastentabelle in
        // Entwurf §3.2 fuehrt fuer sie allein den Rueckweg AUS dem
        // Schliessknopf (oben behandelt), und `↑` erreicht die Hostzeile
        // ohnehin. Auf einer bereits zugeklappten Hostzeile ebenso.
        if (host === null || !host.expanded) return;
        state.setHostExpanded(host.id, false);
        return;
      }
    }

    // Der Sprung per Erstbuchstabe (Entwurf §3.2, Designsystem 5.2): GENAU
    // EIN Zeichen, kein Puffer. Eine Mehrzeichenfolge braeuchte einen
    // Zeitgeber, der sie wieder leert, und dieses Projekt laesst genau
    // EINEN entprellten Pfad zu (Designsystem 5.5) -- diesen nicht.
    //
    // Die Leertaste ist ausgenommen: die Zeilen sind `<button>`, dort
    // betaetigt sie (Entwurf §3.2, "Space wie Enter"). Und der
    // Strg/Alt/Meta-Raum gehoert `keyboard.ts` (`isAppChord`) -- ohne diese
    // Wache waere `Ctrl+Shift+E` zugleich ein Sprung nach "e".
    if (event.key.length !== 1 || event.key === " ") return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const wanted = event.key.toLowerCase();
    // Ab dem Eintrag NACH dem aktuellen und umlaufend -- ab dem aktuellen
    // bliebe der Zeiger bei mehreren gleich beginnenden Namen auf dem
    // ersten Treffer kleben, und ein zweiter Tastendruck taete nichts.
    for (let step = 1; step <= entries.length; step += 1) {
      const index = (current + step) % entries.length;
      // Gegen `.row-label`, nicht gegen die Zeile: deren `textContent`
      // traegt am Ende noch das Zustandswort und bei Hostzeilen vorn das
      // Chevron -- "b" faende dort nie ein "beta".
      const label = entries[index].querySelector(".row-label")?.textContent ?? "";
      if (!label.toLowerCase().startsWith(wanted)) continue;
      event.preventDefault();
      moveListTo(index);
      return;
    }
    // Nichts passt -- der Zeiger bleibt stehen (Entwurf §3.2).
  });

  // Ebenfalls EINMAL an `list`: der Abgleich beim Betreten von aussen.
  list.addEventListener("focusin", (event) => {
    if (disposed) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const row = target.closest<HTMLElement>(".ab-row");
    if (row === null || !list.contains(row)) return;
    // `focusSidebar()` (Ctrl+Shift+E) nimmt das erste `focusableElements(...)`
    // der Liste AUSSERHALB der Wartet-Spur, und dessen Selektor matcht `button`
    // unabhaengig vom `tabindex` -- der Fokus landet also auf der ersten
    // Hostzeile, gleich ob sie den Zeiger traegt. Ohne diesen Abgleich
    // spraenge die naechste Pfeiltaste an eine ganz andere Stelle.
    setRovingKey(row.dataset.focusKey ?? null);
    applyListRoving(false);
  });

  // --- Roving in der Knopfleiste (Entwurf §3.2 Punkt 2, §3.3) -----------
  //
  // Dieselbe Form zum dritten Mal (Menue, Liste, Leiste): ein `apply…` als
  // einziger Schreiber der `0`, ein `move…To`, ein Tastaturhorcher.
  //
  // KEIN `role="toolbar"`: §3.2s "als Werkzeugleiste" beschreibt das
  // Halte-Modell, nicht die ARIA-Rolle. Eine echte Rolle verlangte einen
  // zugaenglichen Namen, also einen achten i18n-Schluessel -- §6 des
  // Entwurfs nennt sieben.

  /** Welcher Host besitzt den Werkzeugleisten-Halt? ABGELEITET aus dem Zeiger
   * der Liste, nie eigens gespeichert: eine zweite Variable daneben hiesse
   * zwei Besitzer fuer dieselbe Frage, und sie liefen beim ersten
   * Zeilenwechsel auseinander. Eine SESSIONzeile zaehlt zu ihrem Host.
   *
   * Ueber `closest`, NICHT durch Zerlegen von `rovingKey`: dessen Sessionform
   * lautet `session:<hostId>/<name>:row`, und `<name>` kommt ungefiltert aus
   * tmux -- er darf `:` und `/` tragen. Der Wert wird hier nur VERGLICHEN,
   * wie ueberall sonst in dieser Datei. Eine Zeile der Wartet-Spur zaehlt zu
   * dem Host, den sie in `data-owner-host-id` traegt. */
  function owningHostId(): string | null {
    const entries = listEntries();
    const current = entries.find((e) => e.dataset.focusKey === rovingKey);
    if (!current) return null;
    const block = current.closest(".sb-host-block");
    // Spec 2026-10-19 §7: eine Zeile der Wartet-Spur steht in keinem
    // Hostblock und nennt ihren Host selbst (`data-owner-host-id`).
    if (!block) return current.dataset.ownerHostId ?? null;
    const row = block.querySelector<HTMLElement>(".row-host");
    return row?.dataset.hostId ?? null;
  }

  /** Host der Session in der fokussierten Kachel, sonst null. */
  function hostOfFocusedTile(): string | null {
    const key = state.focusedSessionKey();
    if (key === null) return null;
    return state.hosts.find((h) => h.sessions.some((s) => sessionKeyOf(s) === key))?.id ?? null;
  }

  /** Spec 7.3: der aktive Host. Steht der Fokus im offenen `⋯`-Menue, ist das
   * dessen Host; steht er in der Liste, der Host des Roving-Zeigers; sonst der
   * Host der fokussierten Kachel; sonst der Host des Roving-Zeigers (der zeigt
   * IMMER auf einen Eintrag, `applyListRoving`). Eine Ableitung fuer beide
   * Leser: die Markierung unten und `main.ts` (`SidebarHandle.activeHostId`,
   * UX-Spec §7.9). */
  function activeHostId(): string | null {
    const active = document.activeElement;
    // Abnahme B2, Nachtrag: das Menue haengt an `root`, nicht an `list`. Ohne
    // diese Zeile fiele die Ableitung bei Fokus darin auf die fokussierte
    // Kachel zurueck, und deren Leiste erschiene unter dem offenen Menue --
    // nach dem Aufholen eines Klicks auf `⋯` und bei jedem Neuzeichnen.
    if (menuEl !== null && active instanceof Node && menuEl.contains(active)) return openMenuHostId;
    const focusInList = active instanceof HTMLElement && list.contains(active);
    return focusInList ? owningHostId() : (hostOfFocusedTile() ?? owningHostId());
  }

  /** Spec 7.3: Hostaktionen nur am aktiven Host -- deshalb ist auch ohne Fokus
   * genau eine Leiste sichtbar (die Dichte-Rechnung in Spec 7.8 nimmt genau das
   * an). Die Sichtbarkeit selbst regelt styles.css ueber diese Klasse plus
   * `:focus-within`; die Roving-Logik bleibt unangetastet. */
  function applyActiveHostClass(): void {
    // Waehrend eines Drucks gilt die eingefrorene Markierung (Abnahme B2,
    // unten), auch fuer Bloecke, die ein Neuzeichnen eben neu gebaut hat --
    // ebenso der gehaltene Block.
    const active = frozenHostId !== undefined ? frozenHostId : activeHostId();
    for (const block of list.querySelectorAll<HTMLElement>(".sb-host-block")) {
      const hostId = blockHostId(block);
      block.classList.toggle("sb-host-block--active", hostId !== null && hostId === active);
      block.classList.toggle("sb-host-block--held", hostId !== null && hostId === heldHostId);
    }
  }

  /** Der Host des Hostblocks, in dem `node` steht, sonst `null`. */
  function blockHostId(node: Element | null): string | null {
    return node?.closest(".sb-host-block")?.querySelector<HTMLElement>(".row-host")?.dataset.hostId ?? null;
  }

  // --- Ein Druck in der Liste (Abnahme B2) -------------------------------
  //
  // Die Zeile nimmt beim Druck den Fokus, und der `focusin`-Abgleich markierte
  // ihren Host sofort als aktiv: dessen Knopfleiste erschien, die des bisher
  // aktiven verschwand, und die Zeilen rueckten noch VOR dem Loslassen um eine
  // Leistenhoehe. Das Loslassen traf eine andere Zeile, der Klick ging an einen
  // gemeinsamen Vorfahren, und der erste Klick auf eine Zeile eines nicht
  // aktiven Hosts war verloren.
  //
  // Waehrend eines Drucks der primaeren Taste bleibt deshalb stehen, welche
  // Leisten beim Druck zu sehen WAREN: die Markierung haelt den Host, der
  // markiert war -- das Sichtbare, nicht `activeHostId()`. Beide weichen nur
  // ab, wenn der Fokus die Liste ohne Zustandsaenderung verlassen hat, und
  // dann haelt allein das Sichtbare die Zeilen still. Dazu behaelt der Block,
  // in dem der Fokus beim Druck stand, seine Leiste (`--held`): sie zeigte nur
  // `:focus-within`, etwa bei Fokus in der Hinweisleiste, die den Zeiger nicht
  // bewegt, und sie verschwaende sonst, sobald der Druck den Fokus verschiebt.
  // Die Klasse an der Liste verbirgt jede andere Leiste, die sonst
  // `:focus-within` zeigte (styles.css). Fokus und Roving-Zeiger bewegen sich
  // wie immer, der Druck wird nicht abgefangen.

  /** Der beim Druck markierte Host; `undefined`, solange kein Druck laeuft. */
  let frozenHostId: string | null | undefined;
  /** Der Host des Blocks, in dem beim Druck der Fokus stand; `null` ohne
   * solchen Block oder ohne Druck. */
  let heldHostId: string | null = null;
  let pressEndTimer: ReturnType<typeof window.setTimeout> | undefined;

  list.addEventListener("pointerdown", (event) => {
    if (disposed || event.button !== 0) return;
    // Ein Druck auf die Liste selbst (ihren Rollbalken) oder in ein `select`
    // liefert sein Loslassen nicht verlaesslich ans Fenster; die Markierung
    // bliebe dann eingefroren. Er verschiebt auch keine Zeile.
    const target = event.target;
    if (target === list || (target instanceof Element && target.closest("select"))) return;
    window.clearTimeout(pressEndTimer);
    // Ein neuer Druck, bevor der vorige aufgeholt hat: er haelt, was zu sehen
    // ist, und das Aufholen wartet auf SEIN Ende.
    if (frozenHostId === undefined) {
      frozenHostId = blockHostId(list.querySelector(".sb-host-block--active"));
      // Vor dem Fokuswechsel des Drucks: der Fokus steht noch, wo er stand.
      const focused = document.activeElement;
      heldHostId = focused instanceof Element && list.contains(focused) ? blockHostId(focused) : null;
    }
    list.classList.add("sb-list--pressing");
    applyActiveHostClass();
  });

  // Zwischen den zwei Klicks eines Doppelklicks holt die Markierung auf, die
  // Zeilen ruecken, und der zweite Klick traefe eine Nachbarzeile. In der
  // Liste tut ein zweiter Klick (`detail` > 1) deshalb nichts; ein Klick von
  // der Tastatur hat `detail` 0 und bleibt. In der Capture-Phase, vor jedem
  // Lauscher einer Zeile.
  list.addEventListener(
    "click",
    (event) => {
      if (event.detail <= 1) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );

  /** Der zweite Druck eines Doppelklicks nimmt keinen Fokus (Nachpruefung am
   * Fenster, B6). Sein Klick tut nichts (oben), sein `mousedown` aber zog den
   * Fokus auf das Element darunter -- nach dem Aufholen oft die Nachbarzeile
   * oder "New session" -- statt ihn dort zu lassen, wo der erste Klick ihn
   * hinsetzte, meist im Terminal der gewaehlten Kachel. Getippte Buchstaben
   * bewegten dann den Zeiger der Liste, und Enter handelte auf jener Zeile. Ein
   * Feld und markierbarer Text behalten ihren zweiten Druck: dort markiert er
   * ein Wort, der dritte eine Zeile. */
  function onListMouseDown(event: MouseEvent): void {
    if (event.detail <= 1) return;
    const target = event.target;
    if (target instanceof Element && (target.closest("input, textarea, select") || inSelectableText(target))) return;
    event.preventDefault();
  }

  /** Haelt styles.css den Text unter `target` markierbar? Die Antwort steht
   * allein dort (`user-select`, die Liste nach `html, body`), nicht als zweite
   * Selektorliste hier. Von `target` aufwaerts bis zur Liste entscheidet der
   * erste Wert, der nicht `auto` ist: `auto` heisst "wie das Elternelement".
   * Ob eine Engine den Wert vererbt (Chromium) oder nicht (die Spec, jsdom),
   * der erste andere Wert ist derselbe. */
  function inSelectableText(target: Element): boolean {
    for (let node: Element | null = target; node !== null; node = node.parentElement) {
      const value = getComputedStyle(node).getPropertyValue("user-select");
      if (value !== "" && value !== "auto") return value !== "none";
      if (node === list) break;
    }
    return false;
  }
  list.addEventListener("mousedown", onListMouseDown, true);

  /** Ein Tipp per Touch oder Stift wartet nach dem Loslassen auf seinen Klick
   * (`onPressEnd`); so lange hoechstens, falls keiner kommt. */
  const TAP_CLICK_WAIT_MS = 500;
  /** Ein Tipp ist losgelassen, sein Klick steht noch aus. */
  let awaitingTapClick = false;

  /** Am Fenster, damit auch ein Loslassen ausserhalb der Liste zaehlt. Bei
   * der Maus folgt der Klick dem `pointerup` in derselben Aufgabe; erst
   * danach, im naechsten Zeitgeber, holt die Markierung auf. Bei Touch und
   * Stift liefert Chromium `mousedown`, den Fokuswechsel und den Klick erst
   * aus der Tippgeste, nach dem `pointerup`: holte die Markierung schon dort
   * auf, verschoebe der Fokuswechsel die Zeilen vor dem Klick, und der Tipp
   * auf eine Zeile eines anderen Hosts ginge verloren. Ein solcher Druck endet
   * deshalb erst mit seinem Klick (`onTapClick`), ohne Klick -- gezogen oder
   * lange gehalten -- nach `TAP_CLICK_WAIT_MS`. Ebenso endet der Druck, wenn
   * das Fenster den Fokus verliert: ein Loslassen nach Alt+Tab kommt hier nie
   * an, und die Markierung bliebe bis zum naechsten eingefroren. */
  function onPressEnd(event: Event): void {
    if (frozenHostId === undefined) return;
    const tap = event.type === "pointerup" && event instanceof PointerEvent &&
      (event.pointerType === "touch" || event.pointerType === "pen");
    awaitingTapClick = tap;
    endPressAfter(tap ? TAP_CLICK_WAIT_MS : 0);
  }

  function onTapClick(): void {
    if (!awaitingTapClick) return;
    awaitingTapClick = false;
    endPressAfter(0);
  }

  function endPressAfter(ms: number): void {
    window.clearTimeout(pressEndTimer);
    pressEndTimer = window.setTimeout(() => {
      awaitingTapClick = false;
      frozenHostId = undefined;
      heldHostId = null;
      list.classList.remove("sb-list--pressing");
      if (!disposed) applyActiveHostClass();
    }, ms);
  }
  window.addEventListener("pointerup", onPressEnd);
  window.addEventListener("pointercancel", onPressEnd);
  // Ohne Capture: `blur` blubbert nicht, dieser Horcher sieht also nur den
  // Fokusverlust des Fensters, nicht den eines Elements beim Druck selbst.
  window.addEventListener("blur", onPressEnd);
  window.addEventListener("click", onTapClick);

  /** Merkt sich nur, WELCHER Knopf innerhalb der Leiste -- der Host kommt aus
   * `owningHostId()`. Wechselt der Host, faellt der Index auf 0 zurueck
   * (`setRovingKey`). */
  let toolbarIndex = 0;

  /** Die BEDIENBAREN Knoepfe EINER Knopfleiste -- die eine Definition, an die
   * sich Roving, Tastaturhorcher und `focusin`-Abgleich gleichermassen halten
   * (Task 16, Punkt E). Seit "New session" an einem getrennten Host
   * `disabled` ist, gibt es zwei Mengen; wuerde eine der drei Stellen ueber
   * die volle Menge zaehlen und eine andere ueber diese, liefen ihre Indizes
   * auseinander und `←` bliebe am `⋯`-Knopf haengen. Ein deaktivierter Knopf
   * nimmt keinen Fokus an -- ein Halt auf ihm waere eine Sackgasse. */
  function toolbarButtonsOf(actions: HTMLElement): HTMLElement[] {
    return Array.from(actions.querySelectorAll<HTMLButtonElement>("button")).filter(
      (b) => !b.disabled,
    );
  }

  /** Einziger Schreiber von `tabindex="0"` in den Knopfleisten -- die Knoepfe
   * selbst werden unbedingt mit `-1` gebaut (dieselbe Regel wie im Menue und
   * in der Liste). */
  function applyToolbarRoving(takeFocus: boolean): void {
    const hostId = owningHostId();
    for (const actions of list.querySelectorAll<HTMLElement>(".host-actions")) {
      const block = actions.closest(".sb-host-block");
      const owns = block?.querySelector<HTMLElement>(".row-host")?.dataset.hostId === hostId;
      // ZUERST alle auf `-1`, dann der Halt: ein deaktivierter Knopf steht
      // nicht in `buttons` und behielte sonst eine `0` aus einem frueheren
      // Durchgang -- ein Tabstopp, den niemand mehr betreten kann.
      for (const b of actions.querySelectorAll<HTMLElement>("button")) b.tabIndex = -1;
      const buttons = toolbarButtonsOf(actions);
      const index = Math.max(0, Math.min(buttons.length - 1, toolbarIndex));
      buttons.forEach((b, i) => { b.tabIndex = owns && i === index ? 0 : -1; });
      if (owns && takeFocus) buttons[index]?.focus();
    }
  }

  /** Die Knoepfe der Leiste des BESITZENDEN Hosts -- abgeleitet wie
   * `menuItems()` und `listEntries()`, nicht von aussen hereingereicht.
   * `moveToolbarTo` nahm die Knopfmenge frueher als Parameter entgegen und
   * begrenzte gegen die FOKUSSIERTE Leiste, waehrend `applyToolbarRoving`
   * anschliessend die des besitzenden Hosts fokussierte -- zwei Quellen fuer
   * dieselbe Frage. Der `focusin`-Abgleich unten sorgt dafuer, dass beide
   * dasselbe bedeuten; diese Ableitung sorgt dafuer, dass es nur noch eine
   * gibt. */
  function toolbarButtons(): HTMLElement[] {
    const hostId = owningHostId();
    if (hostId === null) return [];
    for (const actions of list.querySelectorAll<HTMLElement>(".host-actions")) {
      const block = actions.closest(".sb-host-block");
      if (block?.querySelector<HTMLElement>(".row-host")?.dataset.hostId === hostId) {
        return toolbarButtonsOf(actions);
      }
    }
    return [];
  }

  /** Begrenzt statt umlaufend -- wie `moveListTo`, anders als das Menue:
   * `Home`/`End` erreichen die Enden dieser kurzen Reihe unmittelbar. */
  function moveToolbarTo(index: number): void {
    const buttons = toolbarButtons();
    if (buttons.length === 0) return;
    toolbarIndex = Math.max(0, Math.min(buttons.length - 1, index));
    applyToolbarRoving(true);
  }

  // Der Gegenpart zum `focusin`-Abgleich der Liste, eine Ebene tiefer -- und
  // der Grund, warum es ihn braucht: der Abgleich der Liste kann diese Menge
  // NICHT mitbedienen, ein Knopf der Leiste liegt nicht in einer `.ab-row`,
  // sein `closest(".ab-row")` ist `null`.
  //
  // Ohne ihn liefen Zeiger und Fokus auseinander, sobald der Fokus eine
  // Leiste betritt, ohne dass die Liste dabei bewegt wurde -- der Weg dahin
  // ist alltaeglich: `closeMenu()` gibt den Fokus an den `⋯`-Knopf zurueck,
  // der Zeiger stand derweil unveraendert bei einem ANDEREN Host. Die
  // naechste Pfeiltaste sprang dann in dessen Leiste, mit Connect/Disconnect
  // einen Knopf daneben.
  list.addEventListener("focusin", (event) => {
    if (disposed) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const actions = target.closest<HTMLElement>(".host-actions");
    if (actions === null || !list.contains(actions)) return;
    // Ueber `toolbarButtonsOf`, wie das Roving selbst: `toolbarIndex` zaehlt
    // in DIESER Menge (Task 16, Punkt E).
    const index = toolbarButtonsOf(actions).indexOf(target);
    if (index === -1) return;
    const hostRow = actions.closest(".sb-host-block")?.querySelector<HTMLElement>(".row-host");
    if (!hostRow) return;
    // NUR bei echtem Hostwechsel, und darum ueber `owningHostId()` statt
    // unbedingt: gehoert der Zeiger schon diesem Host, steht er
    // moeglicherweise auf einer SESSIONzeile (die zaehlt zu ihrem Host,
    // §3.3). Ihn dann auf die Hostzeile zu ziehen naehme dem Nutzer seinen
    // Platz in der Liste -- wer mit dem Tabulator kurz in die Knopfleiste
    // und zurueckgeht, landete eine Zeile hoeher als er losging.
    //
    // ERST der Zeiger, DANN der Platz: `setRovingKey` setzt `toolbarIndex`
    // auf 0 zurueck, wenn der besitzende Host wechselt -- in umgekehrter
    // Reihenfolge loeschte es genau den Platz, den es hier zu uebernehmen
    // gilt.
    if (owningHostId() !== hostRow.dataset.hostId) {
      setRovingKey(hostRow.dataset.focusKey ?? null);
    }
    toolbarIndex = index;
    // `false`: NUR die Halte neu vergeben. Der Fokus steht bereits dort, wo
    // er hingehoert -- ein `true` machte daraus einen Selbstaufruf.
    applyListRoving(false);
  });

  // Der ZWEITE Tastaturhorcher an `list`, neben dem der Liste -- und
  // ausdruecklich gegen ihn abgegrenzt: jener greift auf den Zeilen und, fuer
  // `←`, auf dem Schliessknopf einer Sessionzeile; dieser NUR innerhalb einer
  // `.host-actions`. Die zwei Mengen schneiden sich nicht (ein Schliessknopf
  // liegt in `.sb-session-row`, nie in einer Knopfleiste), keine Taste wird
  // doppelt verbraucht. Am FOKUS entschieden, nicht an `event.target`: der
  // Zeiger dieser Leiste ist der Fokus.
  list.addEventListener("keydown", (event) => {
    if (disposed) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    const actions = active.closest<HTMLElement>(".host-actions");
    if (actions === null) return;
    // Dieselbe Menge wie `moveToolbarTo` gleich darunter zaehlt (Task 16,
    // Punkt E) -- sonst zeigte `current + 1` in eine andere Reihe.
    const buttons = toolbarButtonsOf(actions);
    const current = buttons.indexOf(active);
    if (current === -1) return;
    switch (event.key) {
      case "ArrowRight": event.preventDefault(); moveToolbarTo(current + 1); break;
      case "ArrowLeft": event.preventDefault(); moveToolbarTo(current - 1); break;
      case "Home": event.preventDefault(); moveToolbarTo(0); break;
      // `Number.MAX_SAFE_INTEGER` statt `buttons.length - 1`: die Laenge
      // gehoert der Menge, gegen die `moveToolbarTo` begrenzt, und die leitet
      // es selbst ab. Die Begrenzung dort macht daraus den letzten Knopf.
      case "End": event.preventDefault(); moveToolbarTo(Number.MAX_SAFE_INTEGER); break;
    }
  });

  /** Abschlussreview (Important 3): rettet den Tastaturfokus ueber das
   * vollstaendige Neuzeichnen hinweg. Gemerkt wird der stabile BEZEICHNER
   * (`data-focus-key`, siehe `focusKey`), nicht die Elementreferenz -- die
   * ist nach `replaceChildren()` aus dem Dokument entfernt und `.focus()`
   * darauf bliebe wirkungslos.
   *
   * Nur, wenn der Fokus VORHER in dieser Seitenleiste stand: `render()`
   * laeuft bei JEDER Zustandsaenderung, auch waehrend ein Dialog offen ist
   * oder ein Terminal den Fokus haelt. Ohne diese Wache waere die Korrektur
   * schlimmer als der Fehler -- die Seitenleiste risse den Fokus dann aus
   * einem laufenden Terminal an sich.
   *
   * Ist das Gegenstueck deaktiviert oder findet sich der Bezeichner nicht
   * wieder, faengt die Hostzeile desselben Hosts den Fokus auf (Aufgabe 19,
   * Fixrunde 3) -- sie ist kein zerstoererisches Ziel. Ist auch sie fort (der
   * Host wurde gerade entfernt), wird NICHTS fokussiert: ein geratener Nachbar
   * waere eine stille Fehlbedienungsquelle -- der Nutzer haette den Fokus auf
   * einem Element, das er nicht angesteuert hat, mit "Remove" in Reichweite. */
  function render(): void {
    for (const [hostId, editor] of controlEditors) {
      const host = state.hosts.find((candidate) => candidate.id === hostId);
      const control = state.controlForHost(hostId);
      if (!host || host.runtimeId !== editor.runtimeId || host.state !== "connected" ||
        control.state === "ready" || control.state === "reconnecting") closeControlEditor(hostId);
      else editor.root.querySelectorAll<HTMLElement>("input, select, button").forEach((element, index) => {
        // Auth changes can introduce credential fields after opening. Assign
        // their key before capturing focus for this render, while DOM is live.
        element.dataset.focusKey = focusKey("host", hostId, `controlForm${index}`);
      });
    }
    if (disposed) return;

    // Gehoert die Rueckfrage zu einem Host, den es nicht mehr gibt, wird sie
    // verworfen -- sonst baute `buildHostBlock` sie zwar nie wieder auf, der
    // Zustand bliebe aber stehen und schluege beim naechsten gleichnamigen
    // Host wieder durch.
    if (pendingRemoveHostId !== null && !state.hosts.some((h) => h.id === pendingRemoveHostId)) {
      pendingRemoveHostId = null;
    }

    // Dasselbe fuer die Beenden-Rueckfrage, und aus demselben Grund: die
    // Session kann verschwinden, waehrend die Frage offen steht (ein
    // "Reload sessions", oder ein Kollege war schneller). Bliebe
    // `pendingKillKey` stehen, erschiene die Rueckfrage spaeter unaufgefordert
    // an einer NEUEN, gleichnamigen Session -- eine offene Frage
    // "This cannot be undone", nach der niemand gefragt hat.
    if (
      pendingKillKey !== null &&
      !state.hosts.some((h) => h.sessions.some((s) => sessionKeyOf(s) === pendingKillKey))
    ) {
      pendingKillKey = null;
    }

    const active = document.activeElement;
    // Zeilen der Wartet-Spur und "+n more" stehen in keinem Hostblock; ihren
    // Host tragen sie selbst (`data-owner-host-id`, waiting-lane.ts).
    const focusedHostId = active instanceof HTMLElement && list.contains(active)
      ? active.closest(".sb-host-block")?.querySelector<HTMLElement>(".row-host")?.dataset.hostId ??
        active.dataset.ownerHostId
      : undefined;
    const keyToRestore =
      active instanceof HTMLElement && el.contains(active) ? (active.dataset.focusKey ?? null) : null;

    // Befund 11: ein getippter Wert (Passphrase/Passwort in der
    // Hinweisleiste, siehe `buildHostNotice`) ueberlebt ein Neuzeichnen NUR,
    // solange das Feld fokussiert ist -- derselbe Wachhund wie `keyToRestore`
    // oben (dieselbe `active`-Quelle), zusaetzlich auf `HTMLInputElement`
    // eingeschraenkt. `value`/`selectionStart`/`selectionEnd` MUESSEN VOR
    // `list.replaceChildren()` gelesen werden: das entfernte Element behaelt
    // zwar seine Eigenschaften, aber `document.activeElement` waere danach
    // nicht mehr dieses Element.
    const activeInput = active instanceof HTMLInputElement && el.contains(active) ? active : null;
    const inputToRestore = activeInput
      ? { value: activeInput.value, start: activeInput.selectionStart, end: activeInput.selectionEnd }
      : null;

    list.replaceChildren();
    // Spec 2026-10-19 §7: die Wartet-Spur steht ueber den Hosts.
    const laneEl = lane.build(keyToRestore?.startsWith("lane:") ?? false);
    if (laneEl) list.appendChild(laneEl);
    renderedNotices.clear();
    for (const host of state.hosts) {
      list.appendChild(buildHostBlock(host));
    }
    for (const key of expandedNotices) {
      if (!renderedNotices.has(key)) expandedNotices.delete(key);
    }

    // Spec 7.8: eine leere Liste sagt, was hier stehen wird und wo es
    // herkommt -- statt einer leeren Flaeche neben einem ebenso leeren
    // Raster. Im Fluss der Liste (kein eigenes Bedienelement): der Weg dahin
    // ist der Add-Knopf im Kopf, der ohnehin schon ein Tabstopp ist.
    if (state.hosts.length === 0) {
      const hint = document.createElement("p");
      hint.className = "sb-empty-hint";
      hint.textContent = t("sidebar.empty.hint");
      list.appendChild(hint);
    }

    // Ein `if`-Block statt einer fruehen Rueckkehr: der Menueabschnitt unten
    // muss AUCH laufen, wenn es nichts wiederherzustellen gibt -- und das
    // ist der Normalfall, denn der Fokus steht meist ausserhalb dieser
    // Leiste (im Terminal). Mit der fruehen Rueckkehr bliebe das Menue in
    // genau diesen Faellen an der alten Stelle stehen.
    if (keyToRestore !== null) {
      // Ueber die Eigenschaft verglichen statt per Attributselektor: ein
      // Sessionname stammt aus tmux und geht ungefiltert in den Bezeichner
      // ein -- ein Selektorstring muesste dafuer maskiert werden, dieser
      // Vergleich braucht das nicht.
      const target = Array.from(el.querySelectorAll<HTMLElement>("[data-focus-key]")).find(
        (node) => node.dataset.focusKey === keyToRestore,
      );
      // Ueber `focusSessionAction`, nicht direkt: eine Sessionaktion steht
      // unter `visibility: hidden`, solange die Zeile nichts davon traegt, und
      // die Knopfleiste eines Hosts unter `display: none`, solange ihr Block
      // nicht aktiv markiert ist -- und das ist er nach dem Neubau oben noch
      // nicht (siehe dort). Fuer jedes andere Ziel ist es ein blosses `focus()`.
      //
      // Fixrunde 3: `focus()` auf einem deaktivierten Gegenstueck taete nichts
      // (der Host trennte, waehrend "New session" den Fokus hatte), und ein
      // fehlendes (sein Hinweis, seine Session ist fort) gibt es nicht -- in
      // beiden Faellen fiele der Fokus auf <body>. Dann nimmt ihn die Hostzeile
      // desselben Hosts.
      const usable = target && !target.matches(":disabled") ? target : null;
      const hostRow = !usable && focusedHostId ? findByKey(focusKey("host", focusedHostId, "row")) : null;
      if (usable) focusSessionAction(usable);
      else if (hostRow) hostRow.focus();
      else if (
        focusedHostId && removalsInFlight.has(focusedHostId) &&
        !state.hosts.some((host) => host.id === focusedHostId)
      ) addButton.focus();
      // `inputToRestore` ist nur gesetzt, wenn `active` (dieselbe Quelle wie
      // `keyToRestore`) ein `HTMLInputElement` war -- `target` traegt in
      // diesem Fall also denselben Bezeichner UND ist selbst ein frisch
      // gebautes `HTMLInputElement` (Passphrase- oder Passwortfeld), sofern
      // `buildHostNotice` fuer den (unveraendert gebliebenen) `authKind`
      // dasselbe Feld wieder aufbaut.
      if (inputToRestore && target instanceof HTMLInputElement) {
        target.value = inputToRestore.value;
        if (inputToRestore.start !== null && inputToRestore.end !== null) {
          target.setSelectionRange(inputToRestore.start, inputToRestore.end);
        }
      }
    }

    // Das Menue ueberlebt das Neuzeichnen (§1.1), sein Knopf nicht --
    // `render()` baut ihn neu. Also nachmessen, `aria-expanded` am NEUEN
    // Knopf erneut setzen, und schliessen, wenn der Knopf nicht mehr
    // auffindbar ist (der Host ist dann fort).
    if (menuEl && openMenuHostId !== null) {
      const anchor = moreButtonFor(openMenuHostId);
      if (!anchor) closeMenu(false);
      else {
        anchor.setAttribute("aria-expanded", "true");
        positionMenu();
      }
    }

    // `false`: NUR den Tabstopp neu vergeben, NICHT fokussieren. Der Zeiger
    // faellt notfalls auf einen Ueberlebenden (sonst haette die Liste gar
    // keinen Tabstopp mehr), der Fokus folgt ihm ausdruecklich nicht --
    // darueber entscheidet allein der Rettungsblock oben. Vergibt zugleich
    // den Halt der Knopfleiste neu (er haengt am selben Zeiger), darum steht
    // hier kein zweiter Aufruf dafuer.
    applyListRoving(false);

    // ZULETZT, nach `applyListRoving`: der Zeiger kann eben erst auf einen
    // Ueberlebenden gefallen sein, und die Markierung liest ihn. Nicht schon
    // durch `setRovingKey` erledigt -- der laeuft nur, wenn der Zeiger sich
    // bewegt; die fokussierte KACHEL kann sich aber aendern, ohne dass er
    // das tut.
    applyActiveHostClass();
  }

  const unsubscribe = state.subscribe(render);
  render();

  return {
    dispose() {
      disposed = true;
      for (const hostId of controlEditors.keys()) closeControlEditor(hostId);
      unsubscribe();
      lane.dispose();
      // Zuerst: die Horcher an `document`, `window` und `.sb-list` liegen
      // NICHT in `el` und ueberleben das Raeumen sonst.
      closeMenu(false);
      window.removeEventListener("pointerup", onPressEnd);
      window.removeEventListener("pointercancel", onPressEnd);
      window.removeEventListener("blur", onPressEnd);
      window.removeEventListener("click", onTapClick);
      list.removeEventListener("mousedown", onListMouseDown, true);
      window.clearTimeout(pressEndTimer);
      el.replaceChildren();
    },
    closeMenu() {
      closeMenu(false);
    },
    openControlRepair(hostId: string) {
      const host = state.hosts.find((candidate) => candidate.id === hostId);
      if (!disposed && host) openControlEditor(host, false);
    },
    activeHostId() {
      return disposed ? null : activeHostId();
    },
  };
}
