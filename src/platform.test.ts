import { describe, expect, it } from "vitest";
import { isAndroid } from "./platform";

describe("isAndroid (Spec 2026-10-27 §5)", () => {
  it("erkennt Androids System-WebView", () => {
    expect(
      isAndroid(
        "Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP4A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe(true);
  });

  it("verneint WebView2 unter Windows, WKWebView unter macOS und jsdom", () => {
    expect(
      isAndroid(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      ),
    ).toBe(false);
    expect(isAndroid("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe(false);
    expect(isAndroid()).toBe(false);
  });
});
