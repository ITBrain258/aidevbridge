import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REATTACH_DELAYS_MS,
  REATTACH_STABLE_MS,
  createTileReattach,
  type TileReattach,
} from "./tile-reattach";

describe("createTileReattach (UX-Spec §5.5)", () => {
  let attach: ReturnType<typeof vi.fn<() => void>>;
  let hidden: boolean;
  let visibleListeners: Set<() => void>;
  let reattach: TileReattach;

  beforeEach(() => {
    vi.useFakeTimers();
    attach = vi.fn();
    hidden = false;
    visibleListeners = new Set();
    reattach = createTileReattach({
      attach,
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      isHidden: () => hidden,
      onVisible: (callback) => {
        visibleListeners.add(callback);
        return () => visibleListeners.delete(callback);
      },
    });
  });

  afterEach(() => {
    reattach.cancel();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function becomeVisible(): void {
    hidden = false;
    for (const listener of [...visibleListeners]) listener();
  }

  it("veroeffentlicht die Wartezeiten 0,5, 2 und 5 s", () => {
    expect(REATTACH_DELAYS_MS).toEqual([500, 2000, 5000]);
  });

  it("haengt 500 ms nach dem Verlust neu an und zeigt bis zum Anhaengen den Hinweis", () => {
    expect(reattach.lost()).toBe(true);
    expect(reattach.active).toBe(true);
    expect(reattach.attaching).toBe(false);
    vi.advanceTimersByTime(499);
    expect(attach).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(reattach.attaching).toBe(true);
    expect(reattach.active).toBe(true);
    reattach.opened();
    expect(reattach.active).toBe(false);
    expect(reattach.attaching).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("versucht es nach 2 s und 5 s erneut und gibt nach dem dritten Fehlschlag auf", () => {
    reattach.lost();
    vi.advanceTimersByTime(500);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(reattach.failed()).toBe(true);
    expect(reattach.active).toBe(true);
    vi.advanceTimersByTime(1999);
    expect(attach).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(reattach.failed()).toBe(true);
    vi.advanceTimersByTime(4999);
    expect(attach).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(attach).toHaveBeenCalledTimes(3);
    expect(reattach.failed()).toBe(false);
    expect(reattach.active).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(attach).toHaveBeenCalledTimes(3);
  });

  it("wartet bei verborgenem Fenster auf das Sichtbarwerden und versucht es dann sofort", () => {
    hidden = true;
    reattach.lost();
    vi.advanceTimersByTime(60_000);
    expect(attach).not.toHaveBeenCalled();
    expect(reattach.active).toBe(true);
    becomeVisible();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(visibleListeners.size).toBe(0);
  });

  it("meldet sich beim Abbruch vom Sichtbarwerden ab", () => {
    hidden = true;
    reattach.lost();
    vi.advanceTimersByTime(500);
    expect(visibleListeners.size).toBe(1);
    reattach.cancel();
    expect(visibleListeners.size).toBe(0);
    expect(reattach.active).toBe(false);
    becomeVisible();
    expect(attach).not.toHaveBeenCalled();
  });

  it("versucht nach einem Abbruch in der Wartezeit nichts mehr", () => {
    reattach.lost();
    vi.advanceTimersByTime(200);
    reattach.cancel();
    vi.advanceTimersByTime(60_000);
    expect(attach).not.toHaveBeenCalled();
  });

  it("zaehlt einen Verlust kurz nach dem Anhaengen weiter, statt von vorn zu beginnen", () => {
    reattach.lost();
    vi.advanceTimersByTime(500);
    reattach.opened();
    // Der frische Kanal stirbt gleich wieder: die Reihe geht weiter (2 s),
    // sonst haengte sich eine immer wieder sterbende Kachel endlos neu an.
    vi.advanceTimersByTime(REATTACH_STABLE_MS - 1);
    expect(reattach.lost()).toBe(true);
    vi.advanceTimersByTime(1999);
    expect(attach).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(attach).toHaveBeenCalledTimes(2);
    reattach.opened();
    reattach.lost();
    vi.advanceTimersByTime(5000);
    expect(attach).toHaveBeenCalledTimes(3);
    reattach.opened();
    // Alle drei Versuche sind verbraucht.
    expect(reattach.lost()).toBe(false);
    expect(reattach.active).toBe(false);
  });

  it("beginnt nach einem stabilen Anhaengen wieder bei 500 ms", () => {
    reattach.lost();
    vi.advanceTimersByTime(500);
    reattach.failed();
    vi.advanceTimersByTime(2000);
    reattach.opened();
    vi.advanceTimersByTime(REATTACH_STABLE_MS);
    reattach.lost();
    vi.advanceTimersByTime(500);
    expect(attach).toHaveBeenCalledTimes(3);
  });

  it("wertet einen Verlust waehrend des Anhaengens als Fehlschlag dieses Versuchs", () => {
    reattach.lost();
    vi.advanceTimersByTime(500);
    expect(reattach.lost()).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("ignoriert eine zweite Verlustmeldung waehrend der Wartezeit", () => {
    reattach.lost();
    vi.advanceTimersByTime(300);
    expect(reattach.lost()).toBe(true);
    vi.advanceTimersByTime(200);
    expect(attach).toHaveBeenCalledTimes(1);
  });
});
