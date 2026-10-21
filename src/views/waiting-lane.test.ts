import { describe, expect, it } from "vitest";
import { formatWaitTime } from "./waiting-lane";

describe("formatWaitTime (Spec 2026-10-19 §7)", () => {
  it("now unter einer Minute, Minuten unter einer Stunde, sonst Stunden -- an den Grenzen", () => {
    expect(formatWaitTime(0)).toBe("now");
    expect(formatWaitTime(59_999)).toBe("now");
    expect(formatWaitTime(60_000)).toBe("1m");
    expect(formatWaitTime(12 * 60_000 + 59_999)).toBe("12m");
    expect(formatWaitTime(3_600_000 - 1)).toBe("59m");
    expect(formatWaitTime(3_600_000)).toBe("1h");
    expect(formatWaitTime(2 * 3_600_000 + 59 * 60_000)).toBe("2h");
    expect(formatWaitTime(30 * 3_600_000)).toBe("30h");
  });

  it("eine Uhr, die zurueckspringt, ergibt now statt einer negativen Zeit", () => {
    expect(formatWaitTime(-5_000)).toBe("now");
  });
});
