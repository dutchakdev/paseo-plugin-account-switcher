import { describe, expect, it } from "vitest";
import { FAILOVER_KIND, FAILOVER_VERSION, FailoverRowSchema, failoverAction, failoverText, type FailoverRow } from "../shared/failover";

// A fixed formatter keeps the text independent of the machine's time zone and locale.
const at = (value: string) => (value === "2026-10-27T18:00:00Z" ? "18:00" : value);
const row = (patch: Partial<FailoverRow> = {}): FailoverRow => ({
  rowId: "account-failover-agent-1-turn-7", state: "offered", from: "Work", to: "Second", toId: "second",
  resetsAt: "2026-10-27T18:00:00Z", error: null, ...patch,
});

describe("the failover row in the chat", () => {
  it("is the account-failover row, version 1", () => {
    expect([FAILOVER_KIND, FAILOVER_VERSION]).toEqual(["account-failover", 1]);
  });
  it("says until when the limit is used up when it offers a switch", () => {
    expect(failoverText(row(), at)).toBe("Work's limit is used up until 18:00.");
  });
  it("adds that no other account has room when there is nothing to offer", () => {
    expect(failoverText(row({ state: "none", to: null, toId: null }), at)).toBe("Work's limit is used up until 18:00. No other account has room.");
  });
  it("leaves the time out when the provider gave none", () => {
    expect(failoverText(row({ resetsAt: null }), at)).toBe("Work's limit is used up.");
  });
  it("reports the outcome of a switch", () => {
    expect(failoverText(row({ state: "switching" }), at)).toBe("Switching from Work to Second…");
    expect(failoverText(row({ state: "switched" }), at)).toBe("Switched from Work to Second.");
    expect(failoverText(row({ state: "auto" }), at)).toBe("Switched automatically from Work to Second.");
    expect(failoverText(row({ state: "failed", error: "Wait for the agent to finish its response." }), at))
      .toBe("Could not switch to Second: Wait for the agent to finish its response.");
  });
  it("says where the next message runs when an automatic switch did not ask the agent to continue", () => {
    expect(failoverText(row({ state: "auto", resumes: false }), at)).toBe("Switched automatically from Work to Second. Your next message runs on Second.");
    expect(failoverText(row({ state: "auto", resumes: true }), at)).toBe("Switched automatically from Work to Second.");
  });
  it("still reads a row written before the optional fields existed", () => {
    const older = { rowId: "account-failover-agent-1-turn-7", state: "auto", from: "Work", to: "Second", toId: "second", resetsAt: null, error: null };
    const parsed = FailoverRowSchema.parse(older);
    expect(failoverText(parsed, at)).toBe("Switched automatically from Work to Second.");
  });
  it("offers the button only while the switch is on offer", () => {
    expect(failoverAction(row())).toEqual({ label: "Switch to Second and continue", accountId: "second" });
    for (const state of ["none", "switching", "switched", "auto", "failed"] as const) expect(failoverAction(row({ state }))).toBeNull();
    expect(failoverAction(row({ to: null, toId: null }))).toBeNull();
  });
  it("round-trips through JSON and its own schema", () => {
    for (const state of ["offered", "none", "switching", "switched", "auto", "failed"] as const) {
      const value = row({ state, error: state === "failed" ? "busy" : null });
      expect(FailoverRowSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    }
    const quiet = row({ state: "auto", fromId: "work", resumes: false });
    expect(FailoverRowSchema.parse(JSON.parse(JSON.stringify(quiet)))).toEqual(quiet);
  });
  it("rejects data from another shape rather than rendering it", () => {
    expect(FailoverRowSchema.safeParse({ state: "offered", from: "Work" }).success).toBe(false);
    expect(FailoverRowSchema.safeParse(row({ state: "unknown" as FailoverRow["state"] })).success).toBe(false);
  });
});
