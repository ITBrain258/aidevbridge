import { describe, expect, it } from "vitest";
import { RETRY_DELAYS_MS, RETRY_JITTER, retryDelay } from "./retry-schedule";

describe("retryDelay", () => {
  it("folgt ohne Streuung der festen Reihe und endet nach dem fuenften Versuch", () => {
    const middle = () => 0.5;
    expect([0, 1, 2, 3, 4, 5].map((attempt) => retryDelay(attempt, middle))).toEqual([
      2000, 5000, 15000, 30000, 60000, null,
    ]);
  });

  it("streut um hoechstens 20 Prozent nach unten und oben", () => {
    expect(retryDelay(0, () => 0)).toBe(1600);
    expect(retryDelay(0, () => 1)).toBe(2400);
    expect(retryDelay(4, () => 0)).toBe(48000);
    expect(retryDelay(4, () => 1)).toBe(72000);
  });

  it("liefert ganze Millisekunden und nutzt ohne Zufallsquelle Math.random", () => {
    for (let i = 0; i < 20; i++) {
      const delay = retryDelay(1)!;
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(4000);
      expect(delay).toBeLessThanOrEqual(6000);
    }
  });

  it("kennt keinen Versuch vor dem ersten", () => {
    expect(retryDelay(-1, () => 0.5)).toBeNull();
    expect(retryDelay(1.5, () => 0.5)).toBeNull();
  });

  it("veroeffentlicht Reihe und Streuung als Konstanten", () => {
    expect(RETRY_DELAYS_MS).toEqual([2000, 5000, 15000, 30000, 60000]);
    expect(RETRY_JITTER).toBe(0.2);
  });
});
