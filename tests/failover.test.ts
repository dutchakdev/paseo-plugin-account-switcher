import { describe, expect, it } from "vitest";
import { AutoFailoverGuard, extraUsageLeft, failoverDecision, mayBeUsedUp } from "../server/failover";
import type { UsageSnapshot, UsageWindow } from "../shared/contracts";

const now = Date.parse("2026-10-27T12:00:00Z");
const later = "2026-10-27T15:00:00Z", soon = "2026-10-27T13:00:00Z", earlier = "2026-10-27T11:00:00Z";
const window = (usedPercent: number | null, resetsAt: string | null = later, scope: UsageWindow["scope"] = "account"): UsageWindow =>
  ({ id: "w", label: "5 hours", usedPercent, windowDurationMins: 300, resetsAt, scope });
const snapshot = (accountId: string, windows: UsageWindow[], extra: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  accountId, provider: "codex", status: "ok", plan: null, windows,
  fetchedAt: earlier, checkedAt: earlier, nextRetryAt: null, error: null, ...extra,
});
const ready = (id: string) => ({ id, authStatus: "ready", loginToken: null });
const decide = (input: Partial<Parameters<typeof failoverDecision>[0]> & Pick<Parameters<typeof failoverDecision>[0], "accounts" | "usage">) =>
  failoverDecision({ currentId: "current", model: null, now, ...input });

describe("whether a failed turn ran out of its account's limit", () => {
  const accounts = [ready("current"), ready("roomy"), ready("tight"), ready("unknown")];
  const spares = [snapshot("roomy", [window(15)]), snapshot("tight", [window(80)]), snapshot("unknown", [window(null)])];

  it("offers the spare with the most room when the current account is used up", () => {
    const usage = [snapshot("current", [window(100)]), ...spares];
    expect(decide({ accounts, usage })).toEqual({ kind: "offer", fromId: "current", toId: "roomy", resetsAt: later });
  });
  it("offers an account whose room is unknown when it is the only spare", () => {
    const usage = [snapshot("current", [window(100)]), snapshot("unknown", [window(null)])];
    expect(decide({ accounts: [ready("current"), ready("unknown")], usage })).toMatchObject({ kind: "offer", toId: "unknown" });
  });
  // The account stays blocked until its last full account-wide window resets, so that is the time to show.
  it("reports the latest reset of the account-wide windows that are full", () => {
    const fiveHours = "2026-10-27T14:00:00Z", week = "2026-10-30T12:00:00Z";
    const usage = [snapshot("current", [window(100, fiveHours), window(100, week)]), ...spares];
    expect(decide({ accounts, usage })).toMatchObject({ kind: "offer", toId: "roomy", resetsAt: week });
    expect(decide({ accounts, usage: [snapshot("current", [window(100, week), window(100, fiveHours)]), ...spares] })).toMatchObject({ kind: "offer", resetsAt: week });
    expect(decide({ accounts: [ready("current")], usage: usage.slice(0, 1) })).toEqual({ kind: "none", fromId: "current", resetsAt: week });
  });
  it("leaves out of the reset time every window that does not block the account", () => {
    const usage = [snapshot("current", [
      window(100, soon), window(100, "2026-11-01T12:00:00Z", "model"), window(100, "2026-11-02T12:00:00Z", "spend"),
      window(100, earlier), window(50, "2026-11-03T12:00:00Z"), window(null, "2026-11-04T12:00:00Z"),
    ]), ...spares];
    expect(decide({ accounts, usage })).toMatchObject({ kind: "offer", resetsAt: soon });
  });
  it("offers nothing, saying when the limit lifts, when no spare is usable", () => {
    const usage = [snapshot("current", [window(100)]), snapshot("tight", [window(100)]), snapshot("full", [window(10)], { usageAllowed: false })];
    const pool = [ready("current"), ready("tight"), ready("full")];
    expect(decide({ accounts: pool, usage })).toEqual({ kind: "none", fromId: "current", resetsAt: later });
    expect(decide({ accounts: [ready("current")], usage })).toEqual({ kind: "none", fromId: "current", resetsAt: later });
  });
  it("never offers an account that needs sign-in or has a sign-in in progress", () => {
    const pool = [ready("current"), { id: "signing-in", authStatus: "ready", loginToken: "t" }, { id: "signed-out", authStatus: "needs_auth", loginToken: null }];
    const usage = [snapshot("current", [window(100)]), snapshot("signing-in", [window(0)]), snapshot("signed-out", [window(0)])];
    expect(decide({ accounts: pool, usage })).toEqual({ kind: "none", fromId: "current", resetsAt: later });
    expect(decide({ accounts: [...pool, ready("spare")], usage })).toMatchObject({ kind: "offer", toId: "spare" });
  });
  it("skips a Codex spare whose plan lacks the agent's model", () => {
    const sol = "gpt-6.1-sol";
    const usage = [
      snapshot("current", [window(100)], { models: [sol] }),
      snapshot("free", [window(0)], { models: ["gpt-6-luna"] }),
      snapshot("paid", [window(60)], { models: [sol, "gpt-6-luna"] }),
    ];
    const pool = [ready("current"), ready("free"), ready("paid")];
    expect(decide({ accounts: pool, usage, model: sol })).toMatchObject({ kind: "offer", toId: "paid" });
    expect(decide({ accounts: pool.filter(account => account.id !== "paid"), usage, model: sol })).toMatchObject({ kind: "none" });
  });
  it("reports no reset time when the provider only says usage is not allowed", () => {
    const usage = [snapshot("current", [window(10)], { usageAllowed: false }), ...spares];
    expect(decide({ accounts, usage })).toEqual({ kind: "offer", fromId: "current", toId: "roomy", resetsAt: null });
  });
  it("says nothing when the current account is not shown to be used up", () => {
    const rest = spares;
    expect(decide({ accounts, usage: rest })).toBeNull();                                                     // no reading
    expect(decide({ accounts, usage: [snapshot("current", [window(80)]), ...rest] })).toBeNull();             // 80% used
    expect(decide({ accounts, usage: [snapshot("current", [window(100, later, "model")]), ...rest] })).toBeNull(); // only a model's own week
    expect(decide({ accounts, usage: [snapshot("current", [window(100, later, "spend")]), ...rest] })).toBeNull();
    expect(decide({ accounts, usage: [snapshot("current", [window(100, null)]), ...rest] })).toBeNull();      // no known reset
    expect(decide({ accounts, usage: [snapshot("current", [window(100, earlier)]), ...rest] })).toBeNull();   // already reset
    expect(decide({ accounts, usage: [snapshot("current", [window(100)], { status: "unavailable" }), ...rest] })).toBeNull();
  });
  it("does not call a missing model a limit", () => {
    const usage = [snapshot("current", [window(100)], { models: ["gpt-6-luna"] }), snapshot("roomy", [window(0)], { models: ["gpt-6.1-sol"] })];
    expect(decide({ accounts, usage, model: "gpt-6.1-sol" })).toBeNull();
  });
  // A failed refresh keeps the last values as stale: within a window, use only grows until the reset.
  it("counts a full window of a stale reading, but not a stale verdict that usage is not allowed", () => {
    expect(decide({ accounts, usage: [snapshot("current", [window(100)], { status: "stale" }), ...spares] })).toEqual({ kind: "offer", fromId: "current", toId: "roomy", resetsAt: later });
    expect(decide({ accounts, usage: [snapshot("current", [window(10)], { status: "stale", usageAllowed: false }), ...spares] })).toBeNull();
  });
  it("reports the full window's reset when the provider also says usage is not allowed", () => {
    expect(decide({ accounts, usage: [snapshot("current", [window(100, soon)], { usageAllowed: false }), ...spares] })).toEqual({ kind: "offer", fromId: "current", toId: "roomy", resetsAt: soon });
    // A window that already reset says nothing about when the verdict lifts.
    expect(decide({ accounts, usage: [snapshot("current", [window(100, earlier)], { usageAllowed: false }), ...spares] })).toEqual({ kind: "offer", fromId: "current", toId: "roomy", resetsAt: null });
  });
});

describe("whether a completed turn's account is worth reading again", () => {
  it("is when the last reading has a full account-wide window until a later reset", () => {
    expect(mayBeUsedUp(snapshot("current", [window(15), window(100)]), now)).toBe(true);
    expect(mayBeUsedUp(snapshot("current", [window(100)], { status: "stale" }), now)).toBe(true);
  });
  it("is when the last reading says usage is not allowed, however old", () => {
    expect(mayBeUsedUp(snapshot("current", [window(10)], { usageAllowed: false }), now)).toBe(true);
    expect(mayBeUsedUp(snapshot("current", [], { status: "stale", usageAllowed: false }), now)).toBe(true);
  });
  // Claude's extra usage pays for requests past a full 5-hour window, so turns keep completing.
  it("is not while the account's paid extra usage still has room", () => {
    expect(mayBeUsedUp(snapshot("current", [window(100), window(40, null, "spend")]), now)).toBe(false);
    expect(mayBeUsedUp(snapshot("current", [window(100), window(100, null, "spend")]), now)).toBe(true);
    expect(mayBeUsedUp(snapshot("current", [window(100), window(null, null, "spend")]), now)).toBe(true);
    expect(extraUsageLeft(snapshot("current", [window(100), window(99, null, "spend")]))).toBe(true);
    expect(extraUsageLeft(snapshot("current", [window(100), window(100, later, "model")]))).toBe(false);
    expect(extraUsageLeft(undefined)).toBe(false);
  });
  it("is not otherwise, so an ordinary turn costs no provider request", () => {
    expect(mayBeUsedUp(undefined, now)).toBe(false);                                                  // never read
    expect(mayBeUsedUp(snapshot("current", [window(99)]), now)).toBe(false);
    expect(mayBeUsedUp(snapshot("current", [window(100, earlier)]), now)).toBe(false);                // already reset
    expect(mayBeUsedUp(snapshot("current", [window(100, null)]), now)).toBe(false);                   // no known reset
    expect(mayBeUsedUp(snapshot("current", [window(100, later, "model"), window(100, later, "spend")]), now)).toBe(false);
    expect(mayBeUsedUp(snapshot("current", [window(null)], { usageAllowed: true }), now)).toBe(false);
  });
});

describe("when the plugin may switch an agent on its own", () => {
  const minute = 60_000, hour = 60 * minute;
  const t0 = now;

  it("allows the first switch of an agent", () => {
    expect(new AutoFailoverGuard().allow("agent", "turn-1", "a", "b", t0)).toBe(true);
  });
  it("allows one switch per turn", () => {
    const guard = new AutoFailoverGuard();
    guard.record("agent", "turn-1", "a", "b", t0);
    expect(guard.allow("agent", "turn-1", "b", "c", t0 + minute)).toBe(false);
    expect(guard.allow("agent", "turn-2", "b", "c", t0 + minute)).toBe(true);
  });
  it("allows three switches an hour, rolling", () => {
    const guard = new AutoFailoverGuard();
    guard.record("agent", "t1", "a", "b", t0);
    guard.record("agent", "t2", "b", "c", t0 + 10 * minute);
    guard.record("agent", "t3", "c", "d", t0 + 20 * minute);
    expect(guard.allow("agent", "t4", "d", "e", t0 + 30 * minute)).toBe(false);
    // The oldest switch drops out of the hour; the other two still count.
    expect(guard.allow("agent", "t4", "d", "e", t0 + hour)).toBe(true);
    guard.record("agent", "t4", "d", "e", t0 + hour);
    expect(guard.allow("agent", "t5", "e", "f", t0 + hour + minute)).toBe(false);
  });
  it("never switches to an account the agent left within the hour", () => {
    const guard = new AutoFailoverGuard();
    guard.record("agent", "t1", "a", "b", t0);
    expect(guard.allow("agent", "t2", "b", "a", t0 + 10 * minute)).toBe(false);
    expect(guard.allow("agent", "t2", "b", "c", t0 + 10 * minute)).toBe(true);
    expect(guard.allow("agent", "t2", "b", "a", t0 + 61 * minute)).toBe(true);
  });
  it("counts the hour from the switch, not from when it is asked", () => {
    const guard = new AutoFailoverGuard();
    guard.record("agent", "t1", "a", "b", t0);
    expect(guard.allow("agent", "t2", "b", "a", t0 + hour - 1)).toBe(false);
    expect(guard.allow("agent", "t2", "b", "a", t0 + hour)).toBe(true);
  });
  it("keeps each agent's record apart", () => {
    const guard = new AutoFailoverGuard();
    guard.record("one", "t1", "a", "b", t0);
    expect(guard.allow("two", "t2", "b", "a", t0 + minute)).toBe(true);
  });
  it("refuses a switch to the account the agent is already on", () => {
    expect(new AutoFailoverGuard().allow("agent", "t1", "a", "a", t0)).toBe(false);
  });
  it("registers nothing until told", () => {
    const guard = new AutoFailoverGuard();
    expect(guard.allow("agent", "t1", "a", "b", t0)).toBe(true);
    expect(guard.allow("agent", "t1", "a", "b", t0)).toBe(true);
  });
  it("tells whether a turn already had its automatic switch, for that agent and within the hour", () => {
    const guard = new AutoFailoverGuard();
    expect(guard.hasTurn("agent", "t1", t0)).toBe(false);
    guard.record("agent", "t1", "a", "b", t0);
    expect(guard.hasTurn("agent", "t1", t0 + minute)).toBe(true);
    expect(guard.hasTurn("agent", "t2", t0 + minute)).toBe(false);
    expect(guard.hasTurn("other", "t1", t0 + minute)).toBe(false);
    expect(guard.hasTurn("agent", "t1", t0 + hour)).toBe(false);
  });
});
