import { describe, expect, it } from "vitest";
import { accountStatus, freshness, quotaTone, relativeTime, shortCountdown, shortDuration, splitWindows, windowLength } from "../client/format";
import type { Account, UsageSnapshot, UsageWindow } from "../shared/contracts";

const now = Date.parse("2026-09-16T12:00:00Z");
const quota = (id: string, usedPercent: number | null, resetsAt: string | null = "2026-09-16T16:00:00Z"): UsageWindow =>
  ({ id, label: id, usedPercent, windowDurationMins: 300, resetsAt });
const snapshot = (patch: Partial<UsageSnapshot>): UsageSnapshot => ({
  accountId: "a", provider: "claude", status: "ok", plan: "Max", windows: [quota("5h", 0)],
  fetchedAt: "2026-09-16T11:58:00Z", checkedAt: "2026-09-16T11:58:00Z", nextRetryAt: null, error: null, ...patch,
});
const account = (patch: Partial<Account>): Account => ({
  id: "a", provider: "claude", source: "managed", label: "Team", email: null, plan: null, authStatus: "ready", createdAt: "2026-09-15", login: null, ...patch,
});

describe("compact quota layout", () => {
  it("lists measured windows first and keeps every window without data for the details view", () => {
    const windows = [quota("weekly", 4), quota("opus", null), quota("5h", 0), quota("sonnet", null), quota("extra", null)];
    const { known, unknown } = splitWindows(windows);
    expect(known.map((item) => item.id)).toEqual(["weekly", "5h"]);
    expect(unknown.map((item) => item.id)).toEqual(["opus", "sonnet", "extra"]);
    expect(known.length + unknown.length).toBe(windows.length);
  });
  it("treats NaN like a missing measurement", () => {
    expect(splitWindows([quota("x", Number.NaN)]).unknown).toHaveLength(1);
    expect(quotaTone(Number.NaN)).toBe("muted");
  });
  it("maps the 80/95/100 thresholds to theme tones", () => {
    expect([null, 79.9, 80, 94.9, 95, 100].map(quotaTone)).toEqual(["muted", "success", "warning", "warning", "danger", "danger"]);
  });
});

describe("compact time text", () => {
  it("rounds countdowns up to whole minutes and drops empty units", () => {
    expect(shortDuration(30_000)).toBe("1 min");
    expect(shortDuration(2 * 3_600_000)).toBe("2 hr");
    expect(shortDuration(26 * 3_600_000 + 5 * 60_000)).toBe("1 d 2 hr");
    expect(shortCountdown("2026-09-16T16:00:00Z", now)).toBe("in 4 hr");
    expect(shortCountdown("2026-09-16T11:59:00Z", now)).toBe("reset time passed");
    expect(shortCountdown(null, now)).toBe("reset time unknown");
    expect(shortCountdown("nope", now)).toBe("reset time unknown");
  });
  it("describes data age relative to now", () => {
    expect(relativeTime("2026-09-16T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-09-16T11:45:00Z", now)).toBe("15 min ago");
    expect(relativeTime(null, now)).toBe("unknown");
    expect(windowLength(300)).toBe("5 hr");
    expect(windowLength(10_080)).toBe("7 d");
    expect(windowLength(null)).toBeNull();
    expect(windowLength(0)).toBeNull();
  });
});

describe("freshness line", () => {
  it("keeps stale, unavailable and needs-auth states visible without an error banner", () => {
    expect(freshness(undefined, now)).toEqual({ text: "limits not fetched yet", tone: "muted" });
    expect(freshness(snapshot({}), now)).toEqual({ text: "updated 2 min ago", tone: "muted" });
    expect(freshness(snapshot({ status: "stale" }), now)).toEqual({ text: "stale data · 2 min ago", tone: "warning" });
    expect(freshness(snapshot({ status: "needs_auth" }), now).tone).toBe("warning");
    expect(freshness(snapshot({ status: "unavailable", fetchedAt: null }), now)).toEqual({ text: "limits unavailable · checked 2 min ago", tone: "danger" });
  });
  it("flags a passed reset without inventing new numbers", () => {
    const passed = snapshot({ windows: [quota("5h", 99, "2026-09-16T11:00:00Z")] });
    expect(freshness(passed, now)).toEqual({ text: "reset time passed · data from 2 min ago", tone: "warning" });
    expect(passed.windows[0].usedPercent).toBe(99);
  });
});

describe("account status line", () => {
  it("prefers an open login session over the stored auth status", () => {
    expect(accountStatus(account({ login: { workspaceId: "w", terminalId: "t" } }), undefined)).toEqual({ text: "sign-in in progress", tone: "warning" });
  });
  it("surfaces a quota 401 on an otherwise ready account", () => {
    expect(accountStatus(account({}), snapshot({ status: "needs_auth" }))).toEqual({ text: "limits require sign-in", tone: "warning" });
    expect(accountStatus(account({}), snapshot({}))).toEqual({ text: "sign-in confirmed", tone: "success" });
  });
  it("maps every stored auth status", () => {
    expect(accountStatus(account({ authStatus: "needs_auth" }), undefined).tone).toBe("warning");
    expect(accountStatus(account({ authStatus: "unknown" }), undefined).tone).toBe("muted");
    expect(accountStatus(account({ authStatus: "error" }), undefined)).toEqual({ text: "sign-in error", tone: "danger" });
  });
});
