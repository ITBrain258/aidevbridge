/* Agent status as ONE pill (UI v2 7.6/8.2, M1.2 addendum of 2026-09-14): a
 * CSS shape in the 14-px box plus a short word on a tinted pill. The sidebar
 * row and the tile head both render through here, so shapes, words and
 * tooltips cannot drift apart. */
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

export type AgentStatusKind = "waiting" | "busy" | "idle" | "ended" | "unknown";

export interface AgentStatusView {
  /** Pill color and meaning. "stale": a live value that is history now. */
  kind: AgentStatusKind | "stale";
  /** Shape of the (last) value. */
  shape: AgentStatusKind;
  word: string;
  title: string;
}

const WORDS: Readonly<Record<AgentStatusKind, TranslationKey>> = {
  waiting: "status.waiting",
  busy: "status.busy",
  idle: "status.idle",
  ended: "status.ended",
  unknown: "status.unknown",
};
const KINDS = Object.keys(WORDS) as AgentStatusKind[];

/** `null` renders no pill: nothing observed yet, or a value this UI does not
 * know. `current` is `AppState.isStatusCurrent` for the session's host. */
export function agentStatusView(
  status: string | null | undefined,
  reason: string | null | undefined,
  current: boolean,
  observedAt: number | null,
): AgentStatusView | null {
  if (!status || !KINDS.includes(status as AgentStatusKind)) return null;
  const kind = status as AgentStatusKind;
  const word = t(WORDS[kind]);
  // Spec 4.4 step 1: a live claim of a stale host is only its last
  // observation. Ended and unknown make no live claim and stay as they are.
  const live = kind === "waiting" || kind === "busy" || kind === "idle";
  if (live && !current) {
    if (observedAt === null) {
      return { kind: "stale", shape: kind, word: t("status.stale"), title: t("status.staleTitleNoTime", { last: word }) };
    }
    const time = new Date(observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return {
      kind: "stale",
      shape: kind,
      word: t("status.asOf", { time }),
      title: t("status.staleTitle", { time, last: word }),
    };
  }
  return { kind, shape: kind, word, title: reason || word };
}

export function buildStatusPill(view: AgentStatusView): HTMLSpanElement {
  const pill = document.createElement("span");
  pill.className = `st st-${view.kind}`;
  pill.title = view.title;
  // The word carries the meaning; the shape is decoration for the eye.
  const box = document.createElement("span");
  box.className = "icon-box icon-box--sm";
  box.setAttribute("aria-hidden", "true");
  const shape = document.createElement("span");
  shape.className = view.kind === "stale" ? `ag ag-${view.shape} ag-stale` : `ag ag-${view.shape}`;
  box.appendChild(shape);
  pill.appendChild(box);
  // In eigenem Element: in einer schmalen Kachel blendet styles.css das Wort
  // nur fuer das Auge aus, der Bildschirmleser liest es weiter.
  const word = document.createElement("span");
  word.className = "st-word";
  word.textContent = view.word;
  pill.appendChild(word);
  return pill;
}
