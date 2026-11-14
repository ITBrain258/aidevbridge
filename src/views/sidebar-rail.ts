// Symbolleiste der eingeklappten Seitenleiste (Spec 2026-11-14 §2): ein
// schmaler Streifen an ihrer Stelle. Oben der Zaehler der wartenden Sessions,
// darunter je Host sein Kuerzelquadrat mit Zustand, unten Einstellungen, Marke
// und der Knopf zum Ausklappen. Sie zeigt nur an und fuehrt zurueck: ein Klick
// auf einen Host klappt die Seitenleiste aus und setzt den Fokus auf seine
// Zeile. Verbinden, Sessions und Hinweise bleiben in der Seitenleiste.
//
// `main.ts` haengt sie als eigenes Kind in `#app`, hinter `#sidebar`, und
// schaltet sie ueber `setHidden`. Eingeklappt ohne Symbolleiste (Einstellung
// "Icon rail" aus) und in der kompakten Ansicht ist sie nicht zu sehen.
//
// Anders als die Seitenleiste baut sie bei einer Benachrichtigung nichts neu:
// jeder Host behaelt seinen Knopf, nur Text und Attribute aendern sich. Ein
// Knopf, der zwischen Druecken und Loslassen aus dem Dokument fiele, bekaeme
// keinen Klick (gemessen am 13.11.2026, siehe `requestRender` in sidebar.ts);
// hier faellt keiner heraus, solange es seinen Host gibt.
import { sessionKeyOf, socketOf, type AppState, type Host, type HostState } from "../state/app-state";
import { waitingSessions } from "../state/attention";
import { icon, type IconName } from "../icons";
import { t } from "../i18n/t";
import type { KeymapAction } from "../keymap";
import { buildBrandMark } from "./brand-mark";
import { hostInitials } from "./initials";
import type { SettingsSectionId } from "./settings-dialog";
import { titleWithShortcut } from "./shortcut-title";

export interface SidebarRailOptions {
  /** Klappt die Seitenleiste aus (derselbe Weg wie Strg+Umschalt+B). */
  onExpand: () => void;
  /** Klappt aus und zeigt diesen Host in der Seitenleiste. */
  onShowHost: (hostId: string) => void;
  /** Springt zur naechsten wartenden Session (Strg+Umschalt+A). */
  onNextWaiting: () => void;
  onOpenSettings: (section?: SettingsSectionId) => void;
}

export interface SidebarRailHandle {
  /** Verborgen zeichnet die Leiste nicht mit; beim Zeigen holt sie auf. */
  setHidden(hidden: boolean): void;
  /** Setzt den Fokus auf den Knopf zum Ausklappen. `false`, wenn die Leiste
   * nicht zu sehen ist: verborgen oder in der kompakten Ansicht. */
  focusExpand(): boolean;
  dispose(): void;
}

/** Form und Wort je Hostzustand, wie die Pille der Hostzeile (sidebar.ts). */
function hostShape(state: HostState): { cls: string; label: string } {
  switch (state) {
    case "connected":
      return { cls: "ind ind-sm ind-on", label: t("sidebar.pill.connected") };
    case "disconnected":
      return { cls: "ind ind-sm ind-off", label: t("sidebar.pill.disconnected") };
    case "connecting":
      return { cls: "ind ind-connecting", label: t("sidebar.state.connecting") };
    case "failed":
      return { cls: "ind ind-fail", label: t("sidebar.state.failed") };
  }
}

interface HostEntry {
  button: HTMLButtonElement;
  avatar: HTMLSpanElement;
  shape: HTMLSpanElement;
  flag: HTMLSpanElement;
  text: HTMLSpanElement;
}

/** Schreibt nur, was sich geaendert hat: die Leiste hoert jede
 * Zustandsmeldung, und die meisten betreffen sie nicht. */
function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

function setAttr(node: HTMLElement, name: string, value: string | null): void {
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else if (node.getAttribute(name) !== value) {
    node.setAttribute(name, value);
  }
}

/** Ein Icon-Knopf der Leiste: Glyphe, Name in `title` (mit Kuerzel, wenn es
 * eins gibt) und visuell versteckt als Text (v2 §13.2). */
function railButton(
  iconName: IconName,
  label: string,
  action: KeymapAction | null,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sb-rail-btn";
  button.title = action ? titleWithShortcut(label, action) : label;
  button.appendChild(icon(iconName));
  const text = document.createElement("span");
  text.className = "ab-visually-hidden";
  text.textContent = label;
  button.appendChild(text);
  button.addEventListener("click", onClick);
  return button;
}

/** Haengt die Leiste hinter `after` (in der App `#sidebar`) in dessen
 * Elternelement. Sie beginnt verborgen. */
export function mountSidebarRail(after: HTMLElement, state: AppState, opts: SidebarRailOptions): SidebarRailHandle {
  let disposed = false;
  let hidden = true;
  /** Eine Benachrichtigung kam, waehrend die Leiste verborgen war. */
  let stale = true;

  const root = document.createElement("div");
  root.className = "sb-rail";
  root.hidden = true;
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", t("rail.label"));

  // Der Zaehler der Wartenden: Raute und Zahl wie die Waiting-Pille, das Wort
  // dazu versteckt als Text. Ohne Wartende ist er nicht da.
  const waitingButton = document.createElement("button");
  waitingButton.type = "button";
  waitingButton.className = "sb-rail-waiting";
  waitingButton.hidden = true;
  const waitingShape = document.createElement("span");
  waitingShape.className = "icon-box icon-box--sm";
  waitingShape.setAttribute("aria-hidden", "true");
  const diamond = document.createElement("span");
  diamond.className = "ag ag-waiting";
  waitingShape.appendChild(diamond);
  const waitingCount = document.createElement("span");
  waitingCount.className = "sb-rail-count";
  waitingCount.setAttribute("aria-hidden", "true");
  const waitingText = document.createElement("span");
  waitingText.className = "ab-visually-hidden";
  waitingButton.append(waitingShape, waitingCount, waitingText);
  waitingButton.addEventListener("click", () => {
    if (!disposed) opts.onNextWaiting();
  });

  const hostsEl = document.createElement("div");
  hostsEl.className = "sb-rail-hosts";

  const bottom = document.createElement("div");
  bottom.className = "sb-rail-bottom";
  const settingsButton = railButton("settings", t("sidebar.settings"), "settings.open", () => {
    if (!disposed) opts.onOpenSettings();
  });
  const brandButton = document.createElement("button");
  brandButton.type = "button";
  brandButton.className = "sb-rail-btn";
  brandButton.title = t("sidebar.about");
  const brandText = document.createElement("span");
  brandText.className = "ab-visually-hidden";
  brandText.textContent = t("sidebar.about");
  brandButton.append(buildBrandMark(), brandText);
  brandButton.addEventListener("click", () => {
    if (!disposed) opts.onOpenSettings("about");
  });
  const expandButton = railButton("panel-left-open", t("rail.expand"), "sidebar.toggle", () => {
    if (!disposed) opts.onExpand();
  });
  expandButton.classList.add("sb-rail-expand");
  bottom.append(settingsButton, brandButton, expandButton);

  root.append(waitingButton, hostsEl, bottom);
  after.insertAdjacentElement("afterend", root);

  const entries = new Map<string, HostEntry>();

  function buildEntry(hostId: string): HostEntry {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sb-rail-host";
    button.dataset.hostId = hostId;
    const avatar = document.createElement("span");
    avatar.className = "sb-avatar";
    avatar.setAttribute("aria-hidden", "true");
    // Der Zustand als Form in der Ecke des Quadrats, auf einem Kreis in der
    // Flaeche der Leiste, der sie vom Quadrat absetzt.
    const badge = document.createElement("span");
    badge.className = "sb-rail-state";
    badge.setAttribute("aria-hidden", "true");
    const shape = document.createElement("span");
    badge.appendChild(shape);
    const flag = document.createElement("span");
    flag.className = "sb-rail-flag";
    flag.setAttribute("aria-hidden", "true");
    flag.hidden = true;
    const flagShape = document.createElement("span");
    flagShape.className = "ag ag-waiting";
    flag.appendChild(flagShape);
    // Form und Fuellung zeigt das Abzeichen; das Wort dazu steht hier als
    // Text und im Tooltip -- nie die Farbe allein (Designsystem §8.4).
    const text = document.createElement("span");
    text.className = "ab-visually-hidden";
    button.append(avatar, badge, flag, text);
    button.addEventListener("click", () => {
      if (!disposed) opts.onShowHost(hostId);
    });
    return { button, avatar, shape, flag, text };
  }

  function updateEntry(entry: HostEntry, host: Host, focusedHostId: string | null): void {
    setText(entry.avatar, hostInitials(host.label, host.hostname));
    // UX-Spec §5.4, wie die Hostzeile: verbindet die App selbst neu, steht
    // zwischen zwei Versuchen die Form von "Offline" statt des Dreiecks, und
    // das Wort sagt "Reconnecting…".
    const reconnecting = host.state !== "connected" && state.isHostReconnecting(host.id);
    const shown: HostState = reconnecting && host.state === "failed" ? "disconnected" : host.state;
    const { cls, label } = hostShape(shown);
    setAttr(entry.shape, "class", cls);
    setAttr(entry.button, "data-state", shown);
    const waiting = waitingSessions([host], (h, s) => state.isSessionStatusCurrent(h.id, s.name, socketOf(s))).length;
    entry.flag.hidden = waiting === 0;
    const count = host.sessions.length;
    const detail =
      waiting > 0
        ? t("sidebar.host.waitingCount", { count: String(waiting) })
        : count === 1
          ? t("sidebar.host.sessionCountOne")
          : count > 1
            ? t("sidebar.host.sessionCount", { count: String(count) })
            : null;
    const stateWord = reconnecting ? t("sidebar.state.reconnecting") : label;
    const name =
      detail === null
        ? t("rail.host", { host: host.label, state: stateWord })
        : t("rail.hostDetail", { host: host.label, state: stateWord, detail });
    setText(entry.text, name);
    setAttr(entry.button, "title", name);
    // Der Host der fokussierten Kachel, wie die gewaehlte Session der Liste.
    setAttr(entry.button, "aria-current", host.id === focusedHostId ? "true" : null);
  }

  /** Der Host, dessen Session die fokussierte Kachel zeigt. Ueber die
   * Sessionlisten gesucht: der Kachelschluessel bleibt ausserhalb von
   * `app-state.ts` opak. */
  function hostOfFocusedTile(): string | null {
    const key = state.focusedSessionKey();
    if (key === null) return null;
    for (const host of state.hosts) {
      if (host.sessions.some((session) => sessionKeyOf(session) === key)) return host.id;
    }
    return null;
  }

  function render(): void {
    if (disposed) return;
    if (hidden) {
      stale = true;
      return;
    }
    stale = false;

    // Erst die Knoepfe entfernter Hosts: stuende einer noch vorn, haengte die
    // Schleife darunter jeden folgenden Knopf um.
    const known = new Set(state.hosts.map((host) => host.id));
    for (const [hostId, entry] of entries) {
      if (known.has(hostId)) continue;
      entry.button.remove();
      entries.delete(hostId);
    }

    const focusedHostId = hostOfFocusedTile();
    let previous: Element | null = null;
    for (const host of state.hosts) {
      let entry = entries.get(host.id);
      if (!entry) {
        entry = buildEntry(host.id);
        entries.set(host.id, entry);
      }
      updateEntry(entry, host, focusedHostId);
      // Nur umhaengen, wenn die Reihenfolge nicht stimmt: ein Knopf, der
      // schon richtig steht, bleibt im Dokument (siehe Kopfkommentar).
      const expected: Element | null = previous ? previous.nextElementSibling : hostsEl.firstElementChild;
      if (expected !== entry.button) hostsEl.insertBefore(entry.button, expected);
      previous = entry.button;
    }

    const waiting = waitingSessions(state.hosts, (h, s) => state.isSessionStatusCurrent(h.id, s.name, socketOf(s))).length;
    waitingButton.hidden = waiting === 0;
    if (waiting > 0) {
      const label = t("attention.waiting", { count: String(waiting) });
      setText(waitingCount, String(waiting));
      setText(waitingText, label);
      setAttr(waitingButton, "title", titleWithShortcut(label, "session.nextWaiting"));
    }
  }

  const unsubscribe = state.subscribe(render);

  return {
    setHidden(next) {
      if (disposed) return;
      hidden = next;
      root.hidden = next;
      if (!next && stale) render();
    },
    focusExpand() {
      if (disposed || hidden) return false;
      expandButton.focus();
      // In der kompakten Ansicht nimmt das Stylesheet die Leiste heraus; ein
      // Knopf ohne Box nimmt keinen Fokus an.
      return document.activeElement === expandButton;
    },
    dispose() {
      disposed = true;
      unsubscribe();
      root.remove();
    },
  };
}
