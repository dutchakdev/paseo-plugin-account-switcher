import { describe, expect, it, vi } from "vitest";
import { hashAccountKey, UsageScopeSchema, type UsageSourceRegistration } from "@getpaseo/plugin/server/usage";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { discoverAccounts, registerPaseoUsage, usageKey, usageReport } from "../server/paseo-usage";
import type { StoredAccount } from "../server/store";
import type { UsageSnapshot, UsageWindow } from "../shared/contracts";

// Identities as the probes produce them: Claude hashes email and organisation, Codex uses the ChatGPT account ID.
const claudeIdentity = `claude:${"0123456789abcdef".repeat(4)}`;
const otherClaudeIdentity = `claude:${"fedcba9876543210".repeat(4)}`;
const codexIdentity = "5c1f8a52-47b5-4f0e-9a9a-6d7d51b3e2c4";

const account = (overrides: Partial<StoredAccount> & Pick<StoredAccount, "id">): StoredAccount => ({
  provider: "claude", label: overrides.id, source: "managed", email: null, plan: null, authStatus: "ready",
  createdAt: "2026-10-01T00:00:00.000Z", home: `/profiles/${overrides.id}`, identityKey: claudeIdentity, generation: 1, loginToken: null,
  ...overrides,
});
const registry = (...accounts: StoredAccount[]) => ({ accounts });

describe("usageKey", () => {
  it("keeps a Codex account ID as it is", () => {
    expect(usageKey("codex", codexIdentity)).toBe(codexIdentity);
  });
  it("turns a Claude identity's colon into a hyphen", () => {
    expect(usageKey("claude", claudeIdentity)).toBe(`claude-${"0123456789abcdef".repeat(4)}`);
  });
  it("replaces a key Paseo would refuse with the hash of the identity", () => {
    for (const identity of ["person@example.com", "has space", "x".repeat(129), ""]) {
      expect(usageKey("codex", identity)).toBe(hashAccountKey(identity));
      expect(usageKey("codex", identity)).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    }
    expect(usageKey("claude", "claude:person@example.com")).toBe(hashAccountKey("claude:person@example.com"));
  });
  it("accepts the longest valid key", () => {
    expect(usageKey("codex", "x".repeat(128))).toBe("x".repeat(128));
  });
});

describe("discoverAccounts", () => {
  const system = account({ id: "system-claude", source: "system", label: "Current CLI · Claude", identityKey: claudeIdentity });
  const global = { kind: "global" } as const;

  it("lists a signed-in managed account with its label, harness and locator", () => {
    const work = account({ id: "work", label: "Work", identityKey: otherClaudeIdentity });
    const codex = account({ id: "codex-work", provider: "codex", label: "Team", identityKey: codexIdentity });
    expect(discoverAccounts(registry(system, work, codex), global)).toEqual([
      { key: usageKey("claude", otherClaudeIdentity), label: "Work", harness: "Claude Code", input: { accountId: "work" } },
      { key: codexIdentity, label: "Team", harness: "Codex", input: { accountId: "codex-work" } },
    ]);
  });
  it("leaves out the system account and a managed account that is the same login", () => {
    const same = account({ id: "same", label: "Same login", identityKey: claudeIdentity });
    expect(discoverAccounts(registry(system, same), global)).toEqual([]);
  });
  it("compares identities only within a provider", () => {
    const codexSystem = account({ id: "system-codex", provider: "codex", source: "system", identityKey: codexIdentity });
    const claudeWithSameKey = account({ id: "odd", identityKey: codexIdentity });
    expect(discoverAccounts(registry(codexSystem, claudeWithSameKey), global).map(a => a.input)).toEqual([{ accountId: "odd" }]);
  });
  it("lists a managed account when the system account has no identity", () => {
    const work = account({ id: "work", identityKey: otherClaudeIdentity });
    const unknownSystem = account({ id: "system-claude", source: "system", identityKey: null, authStatus: "unknown" });
    expect(discoverAccounts(registry(unknownSystem, work), global)).toHaveLength(1);
  });
  it("skips an account that needs sign-in, is mid-login or has no identity yet", () => {
    const accounts = [
      account({ id: "signed-out", authStatus: "needs_auth", identityKey: otherClaudeIdentity }),
      account({ id: "logging-in", loginToken: "pending", identityKey: otherClaudeIdentity }),
      account({ id: "new", authStatus: "needs_auth", identityKey: null }),
      account({ id: "unknown", authStatus: "unknown", identityKey: null }),
      account({ id: "failed-before-proof", authStatus: "error", identityKey: null }),
    ];
    expect(discoverAccounts(registry(system, ...accounts), global)).toEqual([]);
    expect(discoverAccounts(registry(...accounts), global)).toEqual([]);
  });
  it("keeps an account whose last check failed, so its saved limits still show", () => {
    const flaky = account({ id: "flaky", authStatus: "error", identityKey: otherClaudeIdentity });
    expect(discoverAccounts(registry(flaky), global).map(a => a.input)).toEqual([{ accountId: "flaky" }]);
  });
  it("lists one entry when two accounts are signed in with the same login", () => {
    const first = account({ id: "first", identityKey: otherClaudeIdentity }), second = account({ id: "second", identityKey: otherClaudeIdentity });
    expect(discoverAccounts(registry(first, second), global).map(a => a.input)).toEqual([{ accountId: "first" }]);
  });
  it("leaves the session scope to Paseo's own source", () => {
    const work = account({ id: "work", identityKey: otherClaudeIdentity });
    expect(discoverAccounts(registry(system, work), { kind: "session", provider: "claude", env: { CLAUDE_CONFIG_DIR: "/profiles/work" } })).toEqual([]);
  });
});

// Windows as the collectors write them (tests/usage-parsers.test.ts).
const fiveHour: UsageWindow = { id: "five_hour", label: "5 hours", usedPercent: 40, windowDurationMins: 300, resetsAt: "2026-10-27T18:00:00.000Z", scope: "account" };
const weekly: UsageWindow = { id: "seven_day", label: "Weekly", usedPercent: 12.5, windowDurationMins: 10080, resetsAt: "2026-10-30T00:00:00.000Z", scope: "account" };
const sonnet: UsageWindow = { id: "seven_day_sonnet", label: "Weekly · sonnet", usedPercent: 19, windowDurationMins: 10080, resetsAt: "2026-09-20T00:00:00.000Z", scope: "model" };
const spend: UsageWindow = { id: "extra_usage", label: "Monthly spend", usedPercent: 2.5, windowDurationMins: null, resetsAt: null, detail: "$487.50 of $500.00 left", scope: "spend" };
const snapshot = (overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  accountId: "work", provider: "claude", status: "ok", plan: "max", windows: [fiveHour],
  models: null, usageAllowed: null, fetchedAt: "2026-10-27T15:00:00.000Z", checkedAt: "2026-10-27T15:00:00.000Z", nextRetryAt: null, error: null,
  ...overrides,
});

describe("usageReport", () => {
  it("reports an account window with the plan, marked for the summary", () => {
    const report = usageReport(snapshot());
    expect(report).toMatchObject({ status: "available", planLabel: "max" });
    if (report.status !== "available") throw new Error("expected an available report");
    expect(report.windows).toEqual([expect.objectContaining({ id: "five_hour", usedPct: 40, remainingPct: 60, resetsAt: "2026-10-27T18:00:00.000Z", summary: true })]);
  });
  it("omits the plan label when the provider named no plan", () => {
    const report = usageReport(snapshot({ plan: null }));
    expect(report.status).toBe("available");
    expect("planLabel" in report).toBe(false);
  });
  it("names account windows by their reported duration", () => {
    const report = usageReport(snapshot({ windows: [fiveHour, weekly] }));
    if (report.status !== "available") throw new Error("expected an available report");
    expect(report.windows.map(w => [w.id, w.usedPct, w.summary])).toEqual([["five_hour", 40, true], ["weekly", 12.5, true]]);
  });
  it("keeps a model window under its own id, outside the summary", () => {
    const report = usageReport(snapshot({ windows: [fiveHour, sonnet] }));
    if (report.status !== "available") throw new Error("expected an available report");
    const [, model] = report.windows;
    expect(model).toMatchObject({ id: "seven_day_sonnet:weekly", label: "Weekly · sonnet", usedPct: 19 });
    expect(model?.summary).toBeUndefined();
    expect(model?.shortLabel).toBeUndefined();
  });
  it("keeps a model window's own id and label when it reports no duration", () => {
    const report = usageReport(snapshot({ windows: [{ ...sonnet, windowDurationMins: null }] }));
    if (report.status !== "available") throw new Error("expected an available report");
    expect(report.windows[0]).toMatchObject({ label: "Weekly · sonnet", usedPct: 19 });
    expect(report.windows[0]?.id).toMatch(/^seven_day_sonnet:/);
  });
  it("keeps a window without a duration under its own id and label", () => {
    const report = usageReport(snapshot({ windows: [spend] }));
    if (report.status !== "available") throw new Error("expected an available report");
    expect(report.windows).toEqual([expect.objectContaining({ id: "extra_usage", label: "Monthly spend", usedPct: 2.5 })]);
    expect(report.windows[0]?.summary).toBeUndefined();
  });
  it("keeps a reading with an unknown percentage and does not summarise a window of unknown scope", () => {
    const report = usageReport(snapshot({ windows: [{ ...fiveHour, usedPercent: null, scope: undefined }] }));
    if (report.status !== "available") throw new Error("expected an available report");
    expect(report.windows[0]).toMatchObject({ id: "five_hour", usedPct: null });
    expect(report.windows[0]?.summary).toBeUndefined();
  });
  it("turns each provider-reported amount into a detail", () => {
    const report = usageReport(snapshot({ windows: [fiveHour, spend, { ...weekly, detail: "" }] }));
    if (report.status !== "available") throw new Error("expected an available report");
    expect(report.details).toEqual([{ id: "extra_usage", label: "Monthly spend", value: "$487.50 of $500.00 left" }]);
  });
  it("leaves details out when no window reports an amount", () => {
    const report = usageReport(snapshot());
    expect("details" in report).toBe(false);
  });
  it("still reports saved limits that are stale", () => {
    const report = usageReport(snapshot({ status: "stale", error: "The limits service is temporarily unavailable." }));
    expect(report).toMatchObject({ status: "available", planLabel: "max" });
  });
  it("asks for a sign-in", () => {
    expect(usageReport(snapshot({ status: "needs_auth", windows: [], plan: null }))).toEqual({ status: "error", error: "Needs sign-in in Account Switcher." });
  });
  it("says so when the provider has returned nothing yet", () => {
    const none = { status: "error", error: "No usage data from the provider yet." };
    expect(usageReport(snapshot({ status: "unavailable", windows: [], plan: null, fetchedAt: null }))).toEqual(none);
    expect(usageReport(undefined)).toEqual(none);
  });
});

describe("registerPaseoUsage", () => {
  const live = account({ id: "work", label: "Work", identityKey: otherClaudeIdentity });
  const controller = (snapshots: UsageSnapshot[]) => ({
    ready: Promise.resolve(),
    store: { read: vi.fn(async () => registry(account({ id: "system-claude", source: "system" }), live)) },
    usage: { list: vi.fn(async () => snapshots) },
  });
  const register = (snapshots: UsageSnapshot[] = []) => {
    const sources: UsageSourceRegistration[] = [];
    const fake = controller(snapshots);
    const registered = registerPaseoUsage({ registerUsageSource: (source: UsageSourceRegistration) => { sources.push(source); } } as unknown as PluginServerContext, fake);
    return { registered, source: sources[0], fake };
  };

  it("does nothing on a daemon without usage sources", () => {
    expect(registerPaseoUsage({} as PluginServerContext, controller([]))).toBe(false);
  });
  it("registers one source that accepts only an account locator", () => {
    const { registered, source } = register();
    expect(registered).toBe(true);
    expect(source).toMatchObject({ id: "account-switcher", label: "Account Switcher" });
    expect(source?.input.safeParse({ accountId: "work" }).success).toBe(true);
    expect(source?.input.safeParse({ accountId: "" }).success).toBe(false);
    expect(source?.input.safeParse({}).success).toBe(false);
  });
  it("discovers accounts from the registry", async () => {
    const { source, fake } = register();
    expect(await source?.discover({ kind: "global" })).toEqual([
      { key: usageKey("claude", otherClaudeIdentity), label: "Work", harness: "Claude Code", input: { accountId: "work" } },
    ]);
    expect(fake.store.read).toHaveBeenCalled();
    expect(await source?.discover({ kind: "session", provider: "claude", env: {} })).toEqual([]);
  });
  it("reports the account's cached snapshot without asking the provider", async () => {
    const { source, fake } = register([snapshot({ accountId: "other", plan: "pro" }), snapshot({ accountId: "work" })]);
    expect(await source?.fetch({ accountId: "work" })).toMatchObject({ status: "available", planLabel: "max" });
    expect(fake.usage.list).toHaveBeenCalledTimes(1);
  });
  it("reports an account the plugin has no snapshot for", async () => {
    const { source } = register([snapshot({ accountId: "other" })]);
    expect(await source?.fetch({ accountId: "work" })).toEqual({ status: "error", error: "No usage data from the provider yet." });
  });
  it("reads the scopes Paseo sends and the input it validates", async () => {
    const { source } = register([snapshot()]);
    const global = UsageScopeSchema.parse({ kind: "global" }), session = UsageScopeSchema.parse({ kind: "session", provider: "claude", model: "opus", env: { CLAUDE_CONFIG_DIR: "/profiles/work" } });
    expect((await source?.discover(global))).toHaveLength(1);
    expect(await source?.discover(session)).toEqual([]);
    const input = source?.input.parse({ accountId: "work" });
    expect(await source?.fetch(input)).toMatchObject({ status: "available" });
  });
});
