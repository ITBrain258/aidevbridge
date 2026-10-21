import { describe, expect, it } from "vitest";
import { computeMenuPosition } from "./menu-position";

describe("computeMenuPosition", () => {
  it("stellt das Menue unter den Anker, wenn es passt", () => {
    const p = computeMenuPosition({ left: 40, top: 100, bottom: 124 }, 90, 800);
    expect(p).toEqual({ left: 40, top: 124, openUpward: false });
  });

  it("klappt nach oben, wenn es unten nicht mehr passt", () => {
    // 700 + 90 = 790 <= 800 passt noch; 760 + 90 = 850 nicht mehr.
    const p = computeMenuPosition({ left: 40, top: 736, bottom: 760 }, 90, 800);
    expect(p).toEqual({ left: 40, top: 646, openUpward: true });
  });

  it("bleibt am Rand unten, wenn es GENAU passt", () => {
    // Die Grenze gehoert nach unten -- sonst klappt ein Menue, das exakt
    // buendig abschliesst, ohne Not nach oben.
    const p = computeMenuPosition({ left: 0, top: 686, bottom: 710 }, 90, 800);
    expect(p.openUpward).toBe(false);
    expect(p.top).toBe(710);
  });
});
