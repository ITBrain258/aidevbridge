// Wartet-Spur (Spec 2026-10-19 §7): ganz oben in der Liste der Seitenleiste
// die wartenden Sessions, die aelteste zuerst. Abgeleitet aus dem Zustand --
// sie oeffnet nie selbst eine Kachel (`docs/stand.md`, Feste Vorgaben); ein
// Klick oeffnet nach §5.1, Strg+Klick ersetzt nach §5.2. Solange Zeiger oder
// Fokus in ihr sind, bleibt ihre Reihenfolge stehen (Muster Schnelloeffnen:
// nichts ordnet sich unter dem Zeiger um).
//
// Die Seitenleiste baut ihre Liste bei jeder Benachrichtigung neu; die Spur
// ist darum eine Bauanleitung (`build`) mit eigenem Gedaechtnis fuer
// Reihenfolge, Aufklappen und den Minutentakt der Wartezeit.

import { sessionKeyOf, socketOf, type AppState, type Session, type SessionSocket } from "../state/app-state";
import { waitingByAge, waitingKey, type StatusCurrent } from "../state/attention";
import { DEFAULT_KEYMAP } from "../keymap";
import { hostInitials } from "./initials";
import { buildTileNumber } from "./tile-number";
import en from "../i18n/en.json";

type TranslationKey = keyof typeof en;

function t(key: TranslationKey, params?: Record<string, string>): string {
  const template = en[key];
  if (!params) return template;
  return Object.entries(params).reduce((result, [name, value]) => result.split(`{${name}}`).join(value), template);
}

/** Hoechstens so viele Zeilen, bevor "+n more" kommt (§7). */
export const LANE_VISIBLE_ROWS = 5;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** "now" unter einer Minute, "12m" unter einer Stunde, sonst "2h" (§7). */
export function formatWaitTime(ms: number): string {
  if (ms < MINUTE_MS) return t("lane.wait.now");
  if (ms < HOUR_MS) return t("lane.wait.minutes", { count: String(Math.floor(ms / MINUTE_MS)) });
  return t("lane.wait.hours", { count: String(Math.floor(ms / HOUR_MS)) });
}

export interface WaitingLaneOptions {
  state: AppState;
  isCurrent: StatusCurrent;
  /** Beginn der Warte-Episode je `waitingKey`, `undefined` ohne. */
  waitingSince(key: string): number | undefined;
  /** `socket` nur bei einer Session des Standard-Sockets (Spec 2026-10-25 §7). */
  onOpenSession(hostId: string, name: string, options: { replace: boolean; socket?: SessionSocket }): void;
  /** Die Liste muss neu gebaut werden: Minutentakt, Ende des Festhaltens,
   * Auf- und Zuklappen. */
  requestRender(): void;
}

export interface WaitingLane {
  /** Die Spur dieses Neuzeichnens, `null`, wenn niemand wartet.
   * `focusInLane`: lag der Tastaturfokus vor dem Neuzeichnen in ihr? */
  build(focusInLane: boolean): HTMLElement | null;
  dispose(): void;
}

export function createWaitingLane(list: HTMLElement, opts: WaitingLaneOptions): WaitingLane {
  const { state } = opts;
  let pointerInside = false;
  let focusInside = false;
  /** Die zuletzt gezeigte Reihenfolge (Sessionschluessel). */
  let lastOrder: string[] = [];
  /** Die festgehaltene Reihenfolge, solange Zeiger oder Fokus in der Spur sind. */
  let held: string[] | null = null;
  let expanded = false;
  let tick: number | undefined;
  let disposed = false;

  const inLane = (node: EventTarget | null): boolean => node instanceof Element && node.closest(".sb-lane") !== null;

  /** Betreten: die Reihenfolge, die gerade zu sehen ist, steht ab jetzt. */
  function hold(): void {
    if (held === null) held = lastOrder;
  }

  /** Verlassen: endet das Festhalten, sortiert die Spur neu. */
  function release(): void {
    if (pointerInside || focusInside || held === null) return;
    held = null;
    opts.requestRender();
  }

  const onPointerOver = (event: PointerEvent): void => {
    pointerInside = inLane(event.target);
    if (pointerInside) hold();
    else release();
  };
  const onPointerLeave = (): void => {
    pointerInside = false;
    release();
  };
  const onFocusIn = (event: FocusEvent): void => {
    focusInside = inLane(event.target);
    if (focusInside) hold();
    else release();
  };
  const onFocusOut = (event: FocusEvent): void => {
    if (inLane(event.relatedTarget)) return;
    // Erst nach dem Wechsel: beim Neuzeichnen holt die Seitenleiste den Fokus
    // in dieselbe Zeile zurueck.
    window.setTimeout(() => {
      if (disposed) return;
      focusInside = inLane(document.activeElement);
      release();
    }, 0);
  };
  list.addEventListener("pointerover", onPointerOver);
  list.addEventListener("pointerleave", onPointerLeave);
  list.addEventListener("focusin", onFocusIn);
  list.addEventListener("focusout", onFocusOut);

  function setTick(on: boolean): void {
    if (on && tick === undefined) tick = window.setInterval(opts.requestRender, MINUTE_MS);
    if (!on && tick !== undefined) {
      window.clearInterval(tick);
      tick = undefined;
    }
  }

  function keyOf(session: Session): string {
    return sessionKeyOf(session);
  }

  function buildRow(session: Session, now: number): HTMLElement {
    const host = state.hosts.find((candidate) => candidate.id === session.hostId);
    const key = keyOf(session);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ab-row row-lane";
    // UNBEDINGT `-1`: `applyListRoving` (sidebar.ts) vergibt die `0`.
    row.tabIndex = -1;
    row.dataset.laneKey = key;
    row.dataset.focusKey = `lane:${key}:row`;
    // Die Zeile steht in keinem Hostblock. `owningHostId` (sidebar.ts) liest
    // ihren Host von hier -- sonst haette mit dem Zeiger in der Spur und ohne
    // fokussierte Kachel kein Host seine Knopfleiste (`data-host-id` traegt
    // allein die Hostzeile, darum ein eigener Name).
    row.dataset.ownerHostId = session.hostId;
    const tile = state.tileForSession(key);
    const position = tile ? state.tilePosition(tile.id) : null;
    row.title = t(tile ? "sidebar.session.hintOpen" : "sidebar.session.hintClosed");

    const main = document.createElement("span");
    main.className = "row-lane-main";
    const shapeBox = document.createElement("span");
    shapeBox.className = "icon-box icon-box--sm";
    shapeBox.setAttribute("aria-hidden", "true");
    const shape = document.createElement("span");
    shape.className = "ag ag-waiting";
    shapeBox.appendChild(shape);
    main.appendChild(shapeBox);
    const avatar = document.createElement("span");
    avatar.className = "sb-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = host ? hostInitials(host.label, host.hostname) : "";
    main.appendChild(avatar);
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = session.name;
    main.appendChild(label);
    if (tile && position !== null) main.appendChild(buildTileNumber(position + 1, state.focusedTile === tile.id));
    const time = document.createElement("span");
    time.className = "row-lane-time";
    time.textContent = formatWaitTime(now - (opts.waitingSince(waitingKey(session)) ?? now));
    main.appendChild(time);
    row.appendChild(main);

    if (session.statusReason) {
      const reason = document.createElement("span");
      reason.className = "row-lane-reason";
      reason.textContent = session.statusReason;
      row.appendChild(reason);
    }

    row.addEventListener("click", (event) => {
      if (!disposed) opts.onOpenSession(session.hostId, session.name, openOptions(event.ctrlKey, session));
    });
    return row;
  }

  return {
    build(focusInLane) {
      if (disposed) return null;
      // Die Seitenleiste baut neu und holt den Fokus danach zurueck; ob er in
      // der Spur lag, weiss sie vorher (`data-focus-key` mit "lane:").
      if (focusInLane) {
        focusInside = true;
        hold();
        // Wartet die Session der fokussierten Zeile nicht mehr, findet die
        // Seitenleiste keine Zeile. Den Fokus nimmt dann ihre Hostzeile, deren
        // `focusin` das Festhalten beendet; gibt es auch die nicht mehr, landet
        // er ausserhalb der Liste oder auf <body>, ohne `focusin` oder
        // `focusout` in ihr. Fuer diesen Fall dieselbe Nachpruefung wie in
        // `onFocusOut`, sonst bliebe die Reihenfolge bis zum naechsten
        // `focusin` in der Liste stehen.
        window.setTimeout(() => {
          if (disposed) return;
          focusInside = inLane(document.activeElement);
          release();
        }, 0);
      }
      const now = Date.now();
      let sessions = waitingByAge(state.hosts, opts.isCurrent, opts.waitingSince, now);
      if (held !== null) {
        // Festgehalten: bekannte in ihrer Reihenfolge, neu wartende dahinter.
        // Wer nicht mehr wartet, faellt weg -- die Spur zeigt nur Wartende.
        const rank = new Map(held.map((key, i) => [key, i]));
        sessions = [...sessions].sort(
          (a, b) => (rank.get(keyOf(a)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(keyOf(b)) ?? Number.MAX_SAFE_INTEGER),
        );
      }
      lastOrder = sessions.map(keyOf);
      if (held !== null) held = lastOrder;
      setTick(sessions.length > 0);
      if (sessions.length === 0) {
        expanded = false;
        return null;
      }

      const lane = document.createElement("div");
      lane.className = "sb-lane";
      lane.setAttribute("role", "group");
      lane.setAttribute("aria-label", t("lane.label"));

      const head = document.createElement("div");
      head.className = "sb-lane-head";
      const headShape = document.createElement("span");
      headShape.className = "icon-box icon-box--sm";
      headShape.setAttribute("aria-hidden", "true");
      const diamond = document.createElement("span");
      diamond.className = "ag ag-waiting";
      headShape.appendChild(diamond);
      const title = document.createElement("span");
      title.className = "sb-lane-title";
      title.textContent = t("lane.heading", { count: String(sessions.length) });
      const shortcut = document.createElement("kbd");
      shortcut.textContent = DEFAULT_KEYMAP["session.nextWaiting"];
      head.append(headShape, title, shortcut);
      lane.appendChild(head);

      const shown = expanded ? sessions : sessions.slice(0, LANE_VISIBLE_ROWS);
      for (const session of shown) lane.appendChild(buildRow(session, now));

      if (sessions.length > LANE_VISIBLE_ROWS) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "ab-row row-lane-more";
        more.tabIndex = -1;
        more.dataset.focusKey = "lane:more:toggle";
        // Wie die Zeilen: der Host der ersten gezeigten Zeile (`owningHostId`).
        more.dataset.ownerHostId = shown[0].hostId;
        more.setAttribute("aria-expanded", String(expanded));
        more.textContent = expanded
          ? t("lane.less")
          : t("lane.more", { count: String(sessions.length - LANE_VISIBLE_ROWS) });
        more.addEventListener("click", () => {
          if (disposed) return;
          expanded = !expanded;
          opts.requestRender();
        });
        lane.appendChild(more);
      }
      return lane;
    },
    dispose() {
      disposed = true;
      setTick(false);
      list.removeEventListener("pointerover", onPointerOver);
      list.removeEventListener("pointerleave", onPointerLeave);
      list.removeEventListener("focusin", onFocusIn);
      list.removeEventListener("focusout", onFocusOut);
    },
  };
}

/** Die Optionen einer Wahl: `socket` nur beim Standard-Socket, damit eine
 * eigene Session dieselben Argumente behaelt wie vor ihm. */
export function openOptions(
  replace: boolean,
  session: Pick<Session, "socket">,
): { replace: boolean; socket?: SessionSocket } {
  return socketOf(session) === "default" ? { replace, socket: "default" } : { replace };
}
