import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseClaudeUsage, parseCodexModels, parseCodexUsage } from "../server/usage/parsers";

describe("provider quota payloads", () => {
  it("retains every Codex bucket, zero percent and actual durations", () => {
    const result = parseCodexUsage({ accountId: "a", rateLimitsByLimitId: {
      codex: { planType: "plus", primary: { usedPercent: 0, windowDurationMins: 15, resetsAt: 0 } },
      review: { limitName: "Code review", secondary: { usedPercent: null, windowDurationMins: 10080, resetsAt: null } },
      malformed: true,
    }, rateLimits: { primary: { usedPercent: 50 } } });
    expect(result.identityKey).toBe("a");
    expect(result.windows).toEqual([
      // `rateLimits` names no bucket here, so neither is known to bind the whole account.
      { id: "codex:primary", label: "codex · 15 min", usedPercent: 0, windowDurationMins: 15, resetsAt: "1970-01-01T00:00:00.000Z", scope: "model" },
      { id: "review:secondary", label: "Code review · 7 days", usedPercent: null, windowDurationMins: 10080, resetsAt: null, scope: "model" },
    ]);
    expect(parseCodexUsage({ rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300 } } }).windows[0]?.usedPercent).toBe(3);
  });
  it("reports a usage-based workspace's monthly credit allowance as a window", () => {
    const bucket = { limitId: "codex", limitName: null, primary: null, secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: null },
      individualLimit: { limit: "5000", used: "1234.56", remainingPercent: 75, resetsAt: 1798761600 },
      spendControlReached: false, planType: "enterprise_cbp_usage_based" };
    const result = parseCodexUsage({ accountId: "a", rateLimits: bucket, rateLimitsByLimitId: { codex: bucket } });
    expect(result.plan).toBe("enterprise_cbp_usage_based");
    expect(result.windows).toEqual([
      { id: "codex:individual", label: "codex · monthly credits", usedPercent: 25, windowDurationMins: null, resetsAt: "2027-01-01T00:00:00.000Z", detail: "3,765 of 5,000 credits left", scope: "account" },
    ]);
    expect(parseCodexUsage({ rateLimits: { individualLimit: { limit: "bad", remainingPercent: 120 } } }).windows[0]).toMatchObject({ usedPercent: 0, detail: null, resetsAt: null });
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
  it("reports an enterprise seat's monthly spend allowance instead of empty plan limits", () => {
    const extra_usage = { is_enabled: true, monthly_limit: 50000, used_credits: 1250.0, utilization: 2.5, currency: "USD", decimal_places: 2 };
    expect(parseClaudeUsage({ five_hour: null, seven_day: null, seven_day_opus: null, extra_usage, limits: [] }).windows).toEqual([
      { id: "extra_usage", label: "Monthly spend", usedPercent: 2.5, windowDurationMins: null, resetsAt: null, detail: "$487.50 of $500.00 left", scope: "spend" },
    ]);
    const withLimits = parseClaudeUsage({ five_hour: { utilization: 10, resets_at: null }, seven_day: null, extra_usage: { ...extra_usage, utilization: undefined } });
    expect(withLimits.windows.map((quota) => quota.id)).toEqual(["five_hour", "seven_day", "extra_usage"]);
    expect(withLimits.windows[2]?.usedPercent).toBe(2.5);
    expect(parseClaudeUsage({ five_hour: null, extra_usage: { ...extra_usage, is_enabled: false } }).windows).toHaveLength(1);
  });
});

describe("Codex model list", () => {
  // Captured from `model/list` on codex-cli 0.164.0 for a free ChatGPT account.
  const free = JSON.parse(readFileSync(new URL("./fixtures/codex-model-list-free.json", import.meta.url), "utf8"));
  it("reads the models an account's plan offers", () => {
    expect(parseCodexModels(free)).toEqual({ models: ["gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna"], nextCursor: null });
  });
  it("reports an unreadable list as unknown rather than empty", () => {
    expect(parseCodexModels({})).toBeNull();
    expect(parseCodexModels({ data: [{ displayName: "No id" }] })).toBeNull();
    expect(parseCodexModels({ data: [], nextCursor: "next" })).toEqual({ models: [], nextCursor: "next" });
  });
});

describe("which limits bind the whole account", () => {
  // Captured from `account/rateLimits/read` on codex-cli 0.164.0 for a pro account; identifiers replaced.
  const pro = JSON.parse(readFileSync(new URL("./fixtures/codex-rate-limits-pro.json", import.meta.url), "utf8"));
  it("marks Codex's main bucket as account-wide and passes on the provider's own usage verdict", () => {
    const usage = parseCodexUsage(pro);
    expect(usage.windows.map((window) => [window.id, window.scope])).toEqual([["codex:primary", "account"]]);
    expect(usage.usageAllowed).toBe(true);
    expect(parseCodexUsage({ ...pro, ordinaryUsageAllowed: false }).usageAllowed).toBe(false);
    expect(parseCodexUsage({ ...pro, ordinaryUsageAllowed: undefined }).usageAllowed).toBeNull();
  });
  it("marks another model's bucket as model-scoped", () => {
    const spark = { ...pro.rateLimitsByLimitId.codex, limitId: "gpt-5.3-codex-spark", limitName: "GPT-5.3-Codex-Spark" };
    const usage = parseCodexUsage({ ...pro, rateLimitsByLimitId: { ...pro.rateLimitsByLimitId, [spark.limitId]: spark } });
    expect(usage.windows.filter((window) => window.id.startsWith("gpt-5.3")).map((window) => window.scope)).toEqual(["model"]);
  });
  it("separates Claude's plan windows from model-scoped weeks and the spend allowance", () => {
    const usage = parseClaudeUsage({
      five_hour: { utilization: 10, resets_at: "2026-10-27T15:00:00Z" }, seven_day: { utilization: 20, resets_at: "2026-10-30T00:00:00Z" },
      seven_day_opus: { utilization: 100, resets_at: "2026-10-30T00:00:00Z" },
      limits: [{ kind: "weekly_scoped", percent: 100, resets_at: "2026-10-30T00:00:00Z", scope: { model: { display_name: "Fable" } } }],
      extra_usage: { is_enabled: true, monthly_limit: 50000, used_credits: 50000, utilization: 100 },
    });
    expect(Object.fromEntries(usage.windows.map((window) => [window.id, window.scope]))).toEqual({
      five_hour: "account", seven_day: "account", seven_day_opus: "model", "weekly_scoped:0": "model", extra_usage: "spend",
    });
  });
});
