import { describe, expect, it } from "vitest";
import type { Host, Session } from "./app-state";
import {
  nextWaitingSession,
  updateSeenWaiting,
  updateWaitingSince,
  waitingByAge,
  waitingKey,
  waitingSessions,
  windowTitle,
} from "./attention";

function session(hostId: string, name: string, status: string | null, sessionId: number | null = 1): Session {
  return {
    name,
    hostId,
    open: false,
    inputLocked: false,
    sessionId,
    status,
  };
}

function host(id: string, sessions: Session[]): Host {
  return {
    id,
    runtimeId: "r",
    label: id,
    hostname: id,
    user: "u",
    port: 22,
    keyPath: null,
    authKind: "key",
    state: "connected",
    error: null,
    expanded: true,
    lastCwd: "/tmp",
    sessions,
  };
}

/** Stand-in for `AppState.isStatusCurrent`, which owns the real rule. */
const connected = (h: Host): boolean => h.state === "connected";

describe("waitingSessions", () => {
  it("keeps only waiting rows", () => {
    const hosts = [
      host("h1", [session("h1", "a", "idle"), session("h1", "b", "waiting")]),
      host("h2", [session("h2", "c", "busy"), session("h2", "d", "waiting")]),
    ];
    expect(waitingSessions(hosts, connected).map((row) => row.name)).toEqual(["b", "d"]);
  });

  it("ignores sessions of hosts whose status is not current", () => {
    const hosts = [
      host("h1", [session("h1", "b", "waiting")]),
      host("h2", [session("h2", "d", "waiting")]),
    ];
    // Both hosts are connected; only the status rule separates them.
    expect(waitingSessions(hosts, (h) => h.id !== "h2").map((row) => row.name)).toEqual(["b"]);
  });
});

describe("updateSeenWaiting", () => {
  it("reports a waiting episode once, also across repeated polls and a host outage", () => {
    const waiting = session("h1", "b", "waiting");
    const h = host("h1", [waiting]);
    const first = updateSeenWaiting(new Set(), [h], connected);
    expect(first.newcomers).toEqual([waitingKey(waiting)]);
    const repeat = updateSeenWaiting(first.seen, [h], connected);
    expect(repeat.newcomers).toEqual([]);
    h.state = "failed";
    const outage = updateSeenWaiting(repeat.seen, [h], connected);
    expect(outage.newcomers).toEqual([]);
    h.state = "connected";
    expect(updateSeenWaiting(outage.seen, [h], connected).newcomers).toEqual([]);
  });

  it("keeps the episode while only this session's value is stale; stale -> current waiting is not new", () => {
    const kept = session("h1", "a", "waiting");
    const other = session("h1", "b", "idle");
    const h = host("h1", [kept, other]);
    const stale = new Set<string>();
    // Stand-in for `AppState.isSessionStatusCurrent`: host current, session not kept.
    const current = (candidate: Host, s: Session): boolean => connected(candidate) && !stale.has(s.name);
    const first = updateSeenWaiting(new Set(), [h], current);
    expect(first.newcomers).toEqual([waitingKey(kept)]);
    stale.add("a");
    // A kept value is history: not counted, not a newcomer, but still seen.
    expect(waitingSessions([h], current)).toEqual([]);
    other.status = "waiting";
    const during = updateSeenWaiting(first.seen, [h], current);
    expect(during.newcomers).toEqual([waitingKey(other)]);
    expect(during.seen.has(waitingKey(kept))).toBe(true);
    stale.delete("a");
    const after = updateSeenWaiting(during.seen, [h], current);
    expect(after.newcomers).toEqual([]);
    expect(waitingSessions([h], current).map((s) => s.name)).toEqual(["a", "b"]);
    expect(nextWaitingSession([h], null, (candidate, s) => current(candidate, s) && s.name !== "a")?.name).toBe("b");
  });

  it("reports the session again after it was observed not waiting", () => {
    const s = session("h1", "b", "waiting");
    const h = host("h1", [s]);
    const first = updateSeenWaiting(new Set(), [h], connected);
    s.status = "busy";
    const busy = updateSeenWaiting(first.seen, [h], connected);
    s.status = "waiting";
    expect(updateSeenWaiting(busy.seen, [h], connected).newcomers).toEqual([waitingKey(s)]);
  });
});

describe("windowTitle", () => {
  it("prefixes the waiting count and stays bare when none wait", () => {
    expect(windowTitle("aidevbridge", 0)).toBe("aidevbridge");
    expect(windowTitle("aidevbridge", 2)).toBe("(2) aidevbridge");
  });
});

describe("nextWaitingSession", () => {
  it("cycles through waiting sessions only", () => {
    const hosts = [
      host("h1", [
        session("h1", "a", "idle"),
        session("h1", "b", "waiting"),
        session("h1", "c", "waiting"),
      ]),
    ];
    expect(nextWaitingSession(hosts, null, connected)?.name).toBe("b");
    expect(nextWaitingSession(hosts, "h1/b", connected)?.name).toBe("c");
    expect(nextWaitingSession(hosts, "h1/c", connected)?.name).toBe("b");
  });

  it("skips hosts whose status is not current", () => {
    const hosts = [
      host("h1", [session("h1", "b", "waiting")]),
      host("h2", [session("h2", "d", "waiting")]),
    ];
    expect(nextWaitingSession(hosts, "h2/d", (h) => h.id !== "h1")?.name).toBe("d");
  });
});

describe("updateWaitingSince (Spec 2026-10-19 §7)", () => {
  it("eine laufende Episode behaelt ihren Beginn, eine neue beginnt jetzt, eine beendete faellt weg", () => {
    const previous = new Map([
      ["a", 100],
      ["gone", 50],
    ]);
    expect(updateWaitingSince(previous, new Set(["a", "b"]), 900)).toEqual(
      new Map([
        ["a", 100],
        ["b", 900],
      ]),
    );
  });
});

describe("waitingByAge (Spec 2026-10-19 §7)", () => {
  it("die aelteste zuerst; ohne Beginn zaehlt jetzt, gleich alte in der Reihenfolge der Seitenleiste", () => {
    const h1 = host("h1", [session("h1", "a", "waiting"), session("h1", "b", "waiting"), session("h1", "c", "busy")]);
    const h2 = host("h2", [session("h2", "x", "waiting")]);
    const since = new Map([
      [waitingKey(h1.sessions[1]), 10],
      [waitingKey(h2.sessions[0]), 10],
    ]);
    const names = waitingByAge([h1, h2], connected, (key) => since.get(key), 500).map((s) => s.name);
    expect(names).toEqual(["b", "x", "a"]);
  });

  it("nextWaitingSession folgt mit Beginn der Reihenfolge der Spur", () => {
    const h1 = host("h1", [session("h1", "a", "waiting"), session("h1", "b", "waiting")]);
    const since = new Map([
      [waitingKey(h1.sessions[0]), 200],
      [waitingKey(h1.sessions[1]), 100],
    ]);
    const get = (key: string) => since.get(key);
    expect(nextWaitingSession([h1], null, connected, get, 300)?.name).toBe("b");
    expect(nextWaitingSession([h1], "h1/b", connected, get, 300)?.name).toBe("a");
  });
});
