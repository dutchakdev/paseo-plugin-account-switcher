import { describe, expect, it } from "vitest";
import { currentAccount, currentAccountName, idleForSwitch, percent, quotaLevel, remainingPercent, resetCountdown, usageSummary } from "../client/format";
import type { AccountState, UsageSnapshot } from "../shared/contracts";

describe("quota presentation", () => {
  it("keeps a missing measurement distinct from unused quota", () => {
    expect(percent(null)).toBe("—");
    expect(remainingPercent(null)).toBeNull();
    expect(percent(0)).toBe("0%");
    expect(remainingPercent(0)).toBe(100);
  });
  it("does not invent refreshed quota when the reset timestamp passes", () => {
    const snapshot: UsageSnapshot = {
      accountId: "account", provider: "codex", status: "ok", plan: null,
      windows: [{ id: "primary", label: "5 hours", usedPercent: 99, windowDurationMins: 300, resetsAt: "2026-09-15T10:00:00Z" }],
      fetchedAt: "2026-09-15T09:00:00Z", checkedAt: "2026-09-15T09:00:00Z", nextRetryAt: null, error: null,
    };
    expect(usageSummary(snapshot, Date.parse("2026-09-15T10:01:00Z"))).toBe("1% left · stale");
    expect(resetCountdown(snapshot.windows[0].resetsAt, Date.parse("2026-09-15T10:01:00Z"))).toContain("waiting for new data");
  });
  it("marks the requested thresholds precisely", () => {
    expect([null, 0, 79.9, 80, 94.9, 95, 99.9, 100, 110].map(quotaLevel))
      .toEqual(["unknown", "normal", "normal", "warning", "warning", "critical", "critical", "exhausted", "exhausted"]);
    expect(remainingPercent(110)).toBe(0);
  });
  it("keeps null and invalid reset times unknown", () => {
    expect(resetCountdown(null)).toBe("Reset time unknown");
    expect(resetCountdown("bad-date")).toBe("Reset time unknown");
  });
});

describe("manual switch readiness", () => {
  it("requires observed idle state with no active turn or permission", () => {
    expect(idleForSwitch(null)).toBe(false);
    expect(idleForSwitch({ status: "idle", pendingPermissions: [] })).toBe(true);
    expect(idleForSwitch({ status: "idle", activeTurn: { turnId: "turn" }, pendingPermissions: [] })).toBe(false);
    expect(idleForSwitch({ status: "idle", pendingPermissions: [{}] })).toBe(false);
    for (const status of ["initializing", "running", "error", "closed"]) {
      expect(idleForSwitch({ status, pendingPermissions: [] })).toBe(false);
    }
  });
  it("distinguishes an unbound system session from a failed switch with unknown actual identity", () => {
    const state: AccountState = {
      accounts: [{ id: "system-codex", provider: "codex", source: "system", label: "System Codex", authStatus: "ready", email: null, plan: null, createdAt: "2026-09-15" }],
      bindings: [], defaults: { claude: null, codex: null }, integration: { enabled: true, error: null },
    };
    expect(currentAccount(state, "agent", "codex")?.id).toBe("system-codex");
    expect(currentAccountName(state, "agent", "codex")).toBe("System Codex");
    state.bindings.push({ agentId: "agent", provider: "codex", currentAccountId: null, pendingAccountId: "system-codex", status: "error", error: "Reload failed" });
    expect(currentAccount(state, "agent", "codex")).toBeUndefined();
    expect(currentAccountName(state, "agent", "codex")).toBe("Account not confirmed");
  });
});
