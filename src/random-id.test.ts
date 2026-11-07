import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "./random-id";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("nimmt crypto.randomUUID, wo es das gibt", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("10000000-0000-4000-8000-000000000001");
    expect(randomId()).toBe("10000000-0000-4000-8000-000000000001");
  });

  // macOS 11 mit Safari 14: kein `randomUUID`, aber `getRandomValues`.
  describe("ohne crypto.randomUUID", () => {
    /** Ein `crypto` ohne `randomUUID`, dessen Zufall jedes Byte auf `fill`
     * setzt. */
    function withoutRandomUuid(fill: number): void {
      vi.stubGlobal("crypto", {
        getRandomValues: <T extends ArrayBufferView>(array: T): T => {
          new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(fill);
          return array;
        },
      });
    }

    it("setzt Version und Variante auch bei lauter Einsen", () => {
      withoutRandomUuid(0xff);
      expect(randomId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    });

    it("setzt Version und Variante auch bei lauter Nullen", () => {
      withoutRandomUuid(0x00);
      expect(randomId()).toBe("00000000-0000-4000-8000-000000000000");
    });

    it("liefert die Form einer UUID v4, die das Backend als Kennung annimmt", () => {
      const real = crypto;
      vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
      const ids = new Set(Array.from({ length: 50 }, () => randomId()));
      for (const id of ids) expect(id).toMatch(UUID_V4);
      expect(ids.size).toBe(50);
    });
  });
});
