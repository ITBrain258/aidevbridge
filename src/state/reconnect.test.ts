import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECONNECT_STABLE_MS,
  createHostReconnector,
  isRetryableConnectError,
  type HostReconnector,
  type ReconnectAttemptResult,
} from "./reconnect";

describe("isRetryableConnectError (UX-Spec §5.4)", () => {
  it.each(["host_unreachable", "connect_timeout", "connect_capacity"])("wiederholt den Netzfehler %s", (code) => {
    expect(isRetryableConnectError({ code, message: "x" })).toBe(true);
  });

  it.each([
    "auth_rejected",
    "password_required",
    "passphrase_required",
    "host_key_rejected",
    "connect_cancelled",
    "other",
  ])("wiederholt %s nie", (code) => {
    expect(isRetryableConnectError({ code, message: "x" })).toBe(false);
  });

  it("wiederholt nichts ohne Fehlercode", () => {
    for (const error of [null, undefined, "host_unreachable", 42, {}, { message: "host_unreachable" }, { code: 7 }]) {
      expect(isRetryableConnectError(error)).toBe(false);
    }
  });
});

describe("createHostReconnector (UX-Spec §5.4)", () => {
  const NETWORK: ReconnectAttemptResult = { kind: "failed", error: { code: "host_unreachable", message: "down" } };
  let results: Array<ReconnectAttemptResult | Promise<ReconnectAttemptResult>>;
  let attempt: ReturnType<typeof vi.fn<(hostId: string) => Promise<ReconnectAttemptResult>>>;
  let onActiveChange: ReturnType<typeof vi.fn<(hostId: string, active: boolean) => void>>;
  let reconnector: HostReconnector;

  beforeEach(() => {
    vi.useFakeTimers();
    results = [];
    attempt = vi.fn((_hostId: string) => Promise.resolve(results.shift() ?? NETWORK));
    onActiveChange = vi.fn();
    reconnector = createHostReconnector({
      attempt,
      onActiveChange,
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      // Ohne Streuung: die Versuche liegen genau bei 2, 5, 15, 30 und 60 s.
      random: () => 0.5,
    });
  });

  afterEach(() => {
    reconnector.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** Laesst die Uhr um `ms` laufen und gibt den Versuchen Gelegenheit, aufzuloesen. */
  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it("versucht es nach 2, 5, 15, 30 und 60 s und gibt nach dem fuenften Netzfehler auf", async () => {
    reconnector.start("h1");
    expect(onActiveChange).toHaveBeenCalledWith("h1", true);
    expect(reconnector.isActive("h1")).toBe(true);
    let calls = 0;
    for (const delay of [2000, 5000, 15000, 30000, 60000]) {
      await advance(delay - 1);
      expect(attempt).toHaveBeenCalledTimes(calls);
      await advance(1);
      calls += 1;
      expect(attempt).toHaveBeenCalledTimes(calls);
      expect(attempt).toHaveBeenLastCalledWith("h1");
    }
    expect(onActiveChange).toHaveBeenLastCalledWith("h1", false);
    expect(reconnector.isActive("h1")).toBe(false);
    await advance(10 * 60_000);
    expect(attempt).toHaveBeenCalledTimes(5);
  });

  it("streut die Wartezeit ueber die hereingereichte Zufallsquelle", async () => {
    reconnector.dispose();
    reconnector = createHostReconnector({
      attempt,
      onActiveChange,
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      random: () => 0,
    });
    reconnector.start("h1");
    await advance(1599);
    expect(attempt).not.toHaveBeenCalled();
    await advance(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("endet beim ersten Erfolg", async () => {
    results = [NETWORK, { kind: "connected" }];
    reconnector.start("h1");
    await advance(2000);
    await advance(5000);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onActiveChange).toHaveBeenLastCalledWith("h1", false);
    expect(reconnector.isActive("h1")).toBe(false);
    await advance(10 * 60_000);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it.each(["host_key_rejected", "auth_rejected", "passphrase_required", "password_required", "other"])(
    "endet bei %s sofort und versucht es nicht noch einmal",
    async (code) => {
      results = [{ kind: "failed", error: { code, message: "no" } }];
      reconnector.start("h1");
      await advance(2000);
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(onActiveChange).toHaveBeenLastCalledWith("h1", false);
      await advance(10 * 60_000);
      expect(attempt).toHaveBeenCalledTimes(1);
    },
  );

  it("endet, wenn ein anderer Weg den Versuch ueberholt hat", async () => {
    results = [{ kind: "superseded" }];
    reconnector.start("h1");
    await advance(2000);
    expect(reconnector.isActive("h1")).toBe(false);
    await advance(10 * 60_000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("wertet einen werfenden Versuch als Fehlschlag ohne Code", async () => {
    attempt.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    reconnector.start("h1");
    await advance(2000);
    expect(reconnector.isActive("h1")).toBe(false);
    await advance(10 * 60_000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("beginnt je Host hoechstens eine Reihe", async () => {
    reconnector.start("h1");
    reconnector.start("h1");
    await advance(2000);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onActiveChange.mock.calls.filter(([, active]) => active)).toHaveLength(1);
  });

  it("fuehrt die Reihen mehrerer Hosts unabhaengig", async () => {
    results = [{ kind: "connected" }, NETWORK];
    reconnector.start("h1");
    reconnector.start("h2");
    await advance(2000);
    expect(attempt.mock.calls.map(([hostId]) => hostId)).toEqual(["h1", "h2"]);
    expect(reconnector.isActive("h1")).toBe(false);
    expect(reconnector.isActive("h2")).toBe(true);
  });

  it("versucht nach stop waehrend der Wartezeit nichts mehr", async () => {
    reconnector.start("h1");
    await advance(1000);
    reconnector.stop("h1");
    expect(onActiveChange).toHaveBeenLastCalledWith("h1", false);
    await advance(10 * 60_000);
    expect(attempt).not.toHaveBeenCalled();
  });

  it("uebergeht das Ergebnis eines Versuchs, der beim stop schon lief", async () => {
    let finish!: (result: ReconnectAttemptResult) => void;
    attempt.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    reconnector.start("h1");
    await advance(2000);
    expect(attempt).toHaveBeenCalledTimes(1);
    reconnector.stop("h1");
    finish(NETWORK);
    await advance(10 * 60_000);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onActiveChange.mock.calls.filter(([, active]) => !active)).toHaveLength(1);
  });

  it("zieht den wartenden Versuch bei wake vor und zaehlt danach weiter", async () => {
    reconnector.start("h1");
    await advance(500);
    reconnector.wake();
    await advance(0);
    expect(attempt).toHaveBeenCalledTimes(1);
    // Der vorgezogene Versuch laeuft nicht ein zweites Mal ab ...
    await advance(1500);
    expect(attempt).toHaveBeenCalledTimes(1);
    // ... und der naechste wartet die zweite Stufe ab, nicht wieder die erste.
    await advance(5000 - 1500 - 1);
    expect(attempt).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("startet bei einem Schwall von wake genau einen Versuch", async () => {
    let finish!: (result: ReconnectAttemptResult) => void;
    attempt.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    reconnector.start("h1");
    reconnector.wake();
    reconnector.wake();
    reconnector.wake();
    await advance(0);
    expect(attempt).toHaveBeenCalledTimes(1);
    // Waehrend der Versuch laeuft, startet wake keinen zweiten.
    reconnector.wake();
    await advance(0);
    expect(attempt).toHaveBeenCalledTimes(1);
    finish(NETWORK);
    await advance(0);
    expect(reconnector.isActive("h1")).toBe(true);
  });

  it("gibt nach dem fuenften Fehlschlag auch mit vorgezogenen Versuchen auf", async () => {
    reconnector.start("h1");
    for (let i = 0; i < 5; i++) {
      reconnector.wake();
      await advance(0);
    }
    expect(attempt).toHaveBeenCalledTimes(5);
    expect(reconnector.isActive("h1")).toBe(false);
    reconnector.wake();
    await advance(10 * 60_000);
    expect(attempt).toHaveBeenCalledTimes(5);
  });

  it("setzt die Reihe fort, wenn die neue Verbindung schon waehrend ihres Versuchs verloren geht", async () => {
    let finish!: (result: ReconnectAttemptResult) => void;
    attempt.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    reconnector.start("h1");
    await advance(2000);
    expect(attempt).toHaveBeenCalledTimes(1);
    onActiveChange.mockClear();
    // Der Versuch hat verbunden und wartet noch auf die Sessionliste, da faellt
    // die neue Verbindung schon wieder: kein zweiter Versuch jetzt, aber die
    // Anzeige sagt gleich wieder "Reconnecting…".
    reconnector.start("h1");
    expect(onActiveChange).toHaveBeenCalledWith("h1", true);
    expect(attempt).toHaveBeenCalledTimes(1);
    finish({ kind: "connected" });
    await advance(0);
    expect(reconnector.isActive("h1")).toBe(true);
    expect(onActiveChange).not.toHaveBeenCalledWith("h1", false);
    // Der Zaehler laeuft weiter: der naechste Versuch wartet die zweite Stufe ab.
    await advance(4999);
    expect(attempt).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("zaehlt weiter, wenn eine neue Verbindung keine 10 s haelt, und gibt nach dem fuenften Versuch auf", async () => {
    attempt.mockImplementation(() => Promise.resolve({ kind: "connected" }));
    reconnector.start("h1");
    let calls = 0;
    for (const delay of [2000, 5000, 15000, 30000, 60000]) {
      await advance(delay - 1);
      expect(attempt).toHaveBeenCalledTimes(calls);
      await advance(1);
      calls += 1;
      expect(attempt).toHaveBeenCalledTimes(calls);
      expect(reconnector.isActive("h1")).toBe(false);
      // Die neue Verbindung faellt, bevor sie 10 s gehalten hat.
      await advance(RECONNECT_STABLE_MS - 1);
      reconnector.start("h1");
    }
    // Alle fuenf Versuche sind verbraucht: kein sechster, und die Reihe endet.
    expect(reconnector.isActive("h1")).toBe(false);
    expect(onActiveChange).toHaveBeenLastCalledWith("h1", false);
    await advance(10 * 60_000);
    expect(attempt).toHaveBeenCalledTimes(5);
  });

  it("beginnt nach einer Verbindung, die 10 s haelt, wieder bei 2 s", async () => {
    results = [NETWORK, { kind: "connected" }];
    reconnector.start("h1");
    await advance(2000);
    await advance(5000);
    expect(attempt).toHaveBeenCalledTimes(2);
    await advance(RECONNECT_STABLE_MS);
    reconnector.start("h1");
    await advance(1999);
    expect(attempt).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("vergisst den Zaehler nach stop, auch kurz nach einem Erfolg", async () => {
    results = [{ kind: "connected" }];
    reconnector.start("h1");
    await advance(2000);
    expect(attempt).toHaveBeenCalledTimes(1);
    // Der Nutzer hat uebernommen (Verbinden von Hand, Trennen): eine neue Reihe
    // beginnt wieder bei der ersten Stufe.
    reconnector.stop("h1");
    reconnector.start("h1");
    await advance(1999);
    expect(attempt).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("raeumt beim dispose jeden Zeitgeber ab", async () => {
    reconnector.start("h1");
    reconnector.dispose();
    await advance(10 * 60_000);
    expect(attempt).not.toHaveBeenCalled();
    reconnector.start("h2");
    await advance(10 * 60_000);
    expect(attempt).not.toHaveBeenCalled();
  });
});
