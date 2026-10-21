import { describe, expect, it } from "vitest";
import { appCommit, appVersion, appVersionLine } from "./version";

describe("appVersionLine", () => {
  it("setzt Version und Commit aus den Build-Konstanten zusammen", () => {
    expect(appVersionLine()).toBe("aidevbridge 0.0.0-test (test)");
  });
});

describe("appVersion/appCommit", () => {
  it("liefern die Build-Konstanten einzeln", () => {
    expect(appVersion()).toBe("0.0.0-test");
    expect(appCommit()).toBe("test");
  });
});
