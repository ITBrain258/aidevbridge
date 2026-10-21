import { describe, expect, it } from "vitest";
import { agentStatusView, buildStatusPill } from "./status-pill";

describe("agentStatusView", () => {
  it("gives each current state its own shape and word, with the reason as tooltip", () => {
    expect(agentStatusView("waiting", "permission prompt", true, 0)).toEqual({
      kind: "waiting",
      shape: "waiting",
      word: "Waiting",
      title: "permission prompt",
    });
    expect(agentStatusView("busy", "agent is busy", true, 0)).toEqual({
      kind: "busy",
      shape: "busy",
      word: "Busy",
      title: "agent is busy",
    });
    expect(agentStatusView("idle", null, true, 0)).toEqual({ kind: "idle", shape: "idle", word: "Idle", title: "Idle" });
    expect(agentStatusView("ended", "bound session is absent from a complete inventory", true, 0)).toMatchObject({
      kind: "ended",
      shape: "ended",
      word: "Ended",
    });
    expect(agentStatusView("unknown", "no agent source is attached yet", true, 0)).toMatchObject({
      kind: "unknown",
      shape: "unknown",
      word: "Unknown",
    });
  });

  it("shows a live value of a stale host as history, with the time of its observation", () => {
    const at = new Date(2026, 8, 14, 14, 2).getTime();
    const view = agentStatusView("waiting", "permission prompt", false, at)!;
    expect(view.kind).toBe("stale");
    expect(view.shape).toBe("waiting");
    // Hour format follows the locale (14:02 or 02:02 PM); the minutes do not.
    expect(view.word).toMatch(/^As of \d{1,2}:02/);
    expect(view.title).toMatch(/^Status not updated since \d{1,2}:02.* \(last: Waiting\)$/);
    expect(agentStatusView("busy", null, false, null)).toEqual({
      kind: "stale",
      shape: "busy",
      word: "Not updated",
      title: "Status not updated (last: Busy)",
    });
  });

  it("keeps ended and unknown on a stale host; they make no live claim", () => {
    expect(agentStatusView("ended", null, false, 1000)).toMatchObject({ kind: "ended", word: "Ended" });
    expect(agentStatusView("unknown", null, false, 1000)).toMatchObject({ kind: "unknown", word: "Unknown" });
  });

  it("renders no pill without a known status", () => {
    expect(agentStatusView(null, null, true, null)).toBeNull();
    expect(agentStatusView(undefined, null, true, null)).toBeNull();
    expect(agentStatusView("compacting", null, true, null)).toBeNull();
  });
});

describe("buildStatusPill", () => {
  it("is one pill: an aria-hidden shape box plus the word, tooltip on the pill", () => {
    const pill = buildStatusPill({ kind: "idle", shape: "idle", word: "Idle", title: "agent is idle" });
    expect(pill.className).toBe("st st-idle");
    expect(pill.title).toBe("agent is idle");
    expect(pill.textContent).toBe("Idle");
    const box = pill.querySelector(".icon-box")!;
    expect(box.getAttribute("aria-hidden")).toBe("true");
    expect(box.querySelector(".ag.ag-idle")).not.toBeNull();
  });

  it("draws a stale pill neutral, with the faded shape of the last value", () => {
    const pill = buildStatusPill({ kind: "stale", shape: "waiting", word: "As of 14:02", title: "t" });
    expect(pill.className).toBe("st st-stale");
    expect(pill.querySelector(".ag.ag-waiting.ag-stale")).not.toBeNull();
    expect(pill.textContent).toBe("As of 14:02");
  });
});
