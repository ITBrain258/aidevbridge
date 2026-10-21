import { describe, expect, it } from "vitest";
import { buildTileNumber } from "./tile-number";

describe("buildTileNumber (Spec 2026-10-19 §7)", () => {
  it("zeigt die Ziffer, hohl oder fokussiert gefuellt, nur fuers Auge", () => {
    const plain = buildTileNumber(3, false);
    expect([plain.className, plain.textContent, plain.getAttribute("aria-hidden")]).toEqual(["tile-number", "3", "true"]);
    expect(buildTileNumber(1, true).className).toBe("tile-number tile-number--focused");
  });
});
