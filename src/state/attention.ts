import { sessionKey, type Host, type Session } from "./app-state";

/** Whether a session's agent status is a current observation. The rule lives
 * in `AppState.isSessionStatusCurrent`; callers pass it in. The last value of
 * a stale or disconnected host, or a value kept after a failed status source
 * (UX spec 5.2), is history, not a current waiting session. */
export type StatusCurrent = (host: Host, session: Session) => boolean;

export function waitingSessions(hosts: Host[], isCurrent: StatusCurrent): Session[] {
  const waiting: Session[] = [];
  for (const host of hosts) {
    for (const session of host.sessions) {
      if (session.status === "waiting" && isCurrent(host, session)) waiting.push(session);
    }
  }
  return waiting;
}

export function waitingKey(session: Session): string {
  return `${sessionKey(session.hostId, session.name)}\0${session.sessionId ?? ""}`;
}

/** Keys that start a new waiting episode. A key stays seen while its session
 * keeps waiting or while its status is not current (nothing is observed then:
 * the host is stale or gone, or this one value was kept after a failed
 * source); only an observed non-waiting status ends the episode. Repeated
 * polls, outages, reconnects and a stale -> current waiting therefore do not
 * flash again. */
export function updateSeenWaiting(
  previous: ReadonlySet<string>,
  hosts: Host[],
  isCurrent: StatusCurrent,
): { seen: Set<string>; newcomers: string[] } {
  const seen = new Set<string>();
  const newcomers: string[] = [];
  for (const host of hosts) {
    for (const session of host.sessions) {
      const key = waitingKey(session);
      if (!isCurrent(host, session)) {
        if (previous.has(key)) seen.add(key);
      } else if (session.status === "waiting") {
        seen.add(key);
        if (!previous.has(key)) newcomers.push(key);
      }
    }
  }
  return { seen, newcomers };
}

/** Spec 2026-10-19 §7: seit wann jede Warte-Episode laeuft -- der Zeitpunkt
 * ihrer ersten Beobachtung in diesem Lauf. `seen` ist das Ergebnis von
 * `updateSeenWaiting`: eine Episode, die dort weiterlebt, behaelt ihren
 * Beginn, eine neue beginnt `now`, eine beendete faellt weg. Ein Neustart der
 * App beginnt neu. */
export function updateWaitingSince(
  previous: ReadonlyMap<string, number>,
  seen: ReadonlySet<string>,
  now: number,
): Map<string, number> {
  const since = new Map<string, number>();
  for (const key of seen) since.set(key, previous.get(key) ?? now);
  return since;
}

/** Die wartenden Sessions, die aelteste zuerst (Spec 2026-10-19 §7). Ohne
 * Beginn zaehlt `now`; gleich alte bleiben in der Reihenfolge der
 * Seitenleiste (`Array.prototype.sort` ist stabil). */
export function waitingByAge(
  hosts: Host[],
  isCurrent: StatusCurrent,
  since: (key: string) => number | undefined,
  now: number,
): Session[] {
  return waitingSessions(hosts, isCurrent)
    .map((session) => ({ session, start: since(waitingKey(session)) ?? now }))
    .sort((a, b) => a.start - b.start)
    .map((entry) => entry.session);
}

export function windowTitle(base: string, waitingCount: number): string {
  return waitingCount > 0 ? `(${waitingCount}) ${base}` : base;
}

export function nextWaitingSession(
  hosts: Host[],
  currentKey: string | null,
  isCurrent: StatusCurrent,
  since?: (key: string) => number | undefined,
  now = 0,
): Session | null {
  const waiting = since ? waitingByAge(hosts, isCurrent, since, now) : waitingSessions(hosts, isCurrent);
  if (waiting.length === 0) return null;
  if (currentKey === null) return waiting[0];
  const index = waiting.findIndex(
    (session) => sessionKey(session.hostId, session.name) === currentKey,
  );
  return waiting[(index + 1) % waiting.length];
}
