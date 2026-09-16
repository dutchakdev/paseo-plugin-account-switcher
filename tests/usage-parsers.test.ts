import { describe, expect, it } from "vitest";
import { parseClaudeUsage, parseCodexUsage } from "../server/usage/parsers";

describe("provider quota payloads", () => {
  it("retains every Codex bucket, zero percent and actual durations", () => {
    const result = parseCodexUsage({ accountId: "a", rateLimitsByLimitId: {
      codex: { planType: "plus", primary: { usedPercent: 0, windowDurationMins: 15, resetsAt: 0 } },
      review: { limitName: "Code review", secondary: { usedPercent: null, windowDurationMins: 10080, resetsAt: null } },
      malformed: true,
    }, rateLimits: { primary: { usedPercent: 50 } } });
    expect(result.identityKey).toBe("a");
    expect(result.windows).toEqual([
      { id: "codex:primary", label: "codex · 15 min", usedPercent: 0, windowDurationMins: 15, resetsAt: "1970-01-01T00:00:00.000Z" },
      { id: "review:secondary", label: "Code review · 7 days", usedPercent: null, windowDurationMins: 10080, resetsAt: null },
    ]);
    expect(parseCodexUsage({ rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300 } } }).windows[0]?.usedPercent).toBe(3);
  });
  it("preserves Claude generic, legacy and scoped weekly quotas independently", () => {
    const result = parseClaudeUsage({ five_hour: { utilization: 0, resets_at: null }, seven_day: null,
      seven_day_sonnet: { utilization: 19, resets_at: "2026-09-20T00:00:00Z" },
      limits: [null, {kind: "weekly_scoped", percent: null, scope: {model: {display_name:"Opus"},surface: {display_name:"Claude Code"}}}, {kind: "weekly_scoped",percent:"bad"}, {kind:"daily",percent:20}],
    });
    expect(result.windows).toHaveLength(4);
    expect(result.windows[0]).toMatchObject({ usedPercent: 0, windowDurationMins: 300, resetsAt: null });
    expect(result.windows[1]).toMatchObject({ usedPercent: null, windowDurationMins: 10080 });
    expect(result.windows[3]).toMatchObject({ label: "Weekly · Opus · Claude Code", usedPercent: null });
  });
});
