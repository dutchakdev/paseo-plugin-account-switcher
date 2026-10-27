import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageSnapshot } from "../shared/contracts";
import { SwitchRefusal } from "../server/switching";
import { parseClaudeUsage } from "../server/usage/parsers";

const controller = vi.hoisted(() => {
  const bindNewAgent = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
  const apply = vi.fn(async (agentId: string, _accountId?: string): Promise<unknown> => ({ agentId, provider: "codex", currentAccountId: "second" }));
  const prepare = vi.fn(async (agentId: string, accountId: string | null): Promise<unknown> => ({ agentId, provider: "codex", currentAccountId: "work", pendingAccountId: accountId }));
  // The service's one-step switch for the failover row: select, then apply.
  const switchTo = vi.fn(async (agentId: string, accountId: string): Promise<unknown> => { await prepare(agentId, accountId); return apply(agentId, accountId); });
  const registry = {
    accounts: [{ id: "system-codex", label: "Current CLI · Codex", source: "system", provider: "codex", home: "/home/me/.codex", authStatus: "ready", loginToken: null }, { id: "work", label: "Work", source: "managed", provider: "codex", home: "/profiles/work", authStatus: "ready", loginToken: null }, { id: "second", label: "Second", source: "managed", provider: "codex", home: "/profiles/second", authStatus: "ready", loginToken: null }],
    bindings: [{ agentId: "agent-1", provider: "codex", currentAccountId: "work", launchAccountId: "work" }] as { agentId: string; provider: string; currentAccountId: string | null; launchAccountId: string | null; status?: string }[],
    integration: { enabled: true, error: null, providers: ["claude", "codex"] },
    autoFailover: { claude: false, codex: false },
  };
  const read = vi.fn(async () => registry);
  const change = vi.fn(async (operation: (state: typeof registry) => unknown) => operation(registry));
  // The latest readings the usage service returns for every account.
  const readings: unknown[] = [];
  const refresh = vi.fn(async (_accountId?: string) => structuredClone(readings));
  // The readings it already has, which cost no provider request.
  const cached: unknown[] = [];
  const list = vi.fn(async () => structuredClone(cached));
  // Agents whose launch receipt matches their binding. Like the controller, `accountOf` confirms such a launch for good.
  const receipts = new Set<string>();
  const accountOf = vi.fn(async (_paseo: unknown, agentId: string, provider: string, state: typeof registry = registry) => {
    const bound = state.bindings.find(b => b.agentId === agentId);
    if (!bound) return state.accounts.find(a => a.source === "system" && a.provider === provider)?.id ?? null;
    if (bound.currentAccountId || !receipts.has(agentId)) return bound.currentAccountId;
    const live = registry.bindings.find(b => b.agentId === agentId);
    if (live) live.currentAccountId = bound.launchAccountId;
    return bound.launchAccountId;
  });
  return {
    bindNewAgent, apply, prepare, switchTo, read, change, refresh, readings, list, cached, receipts, accountOf, registry,
    instance: { ready: Promise.resolve(), ensureRuntime: vi.fn(async () => {}), switcher: () => ({ bindNewAgent, apply, prepare, switchTo }), close: vi.fn(async () => {}),
      observeAgentRegistration: vi.fn(), store: { read, change }, usage: { refresh, list }, accountOf },
  };
});
vi.mock("../server/controller", () => ({ AccountController: function AccountController() { return controller.instance; } }));

import contribute from "../index.server";

type Before = (input: { request: any }, context: { paseo: unknown }) => any;
function start() {
  const before = new Map<string, Before>();
  contribute({ handle: () => {}, before: (name: string, handler: Before) => { before.set(name, handler); return () => {}; }, on: () => () => {} } as any);
  return before;
}
function startAll() {
  const before = new Map<string, Before>(), on = new Map<string, (event: any, context: any) => any>(), handlers = new Map<string, (input: any, context: any) => any>();
  contribute({ handle: (contract: { name: string }, handler: any) => { handlers.set(contract.name, handler); }, before: (name: string, handler: Before) => { before.set(name, handler); return () => {}; }, on: (name: string, handler: any) => { on.set(name, handler); return () => {}; } } as any);
  return { before, on, handlers };
}
function paseoRecorder(agent: Record<string, unknown> = { model: null }) {
  const appended: { agentId: string; item: any }[] = [], sent: { agentId: string; text: string }[] = [];
  return { appended, sent, paseo: { agents: { ref: (agentId: string) => ({
    timeline: { append: async (item: unknown) => { appended.push({ agentId, item }); return {}; } },
    refresh: async () => ({ agent: { id: agentId, provider: "codex", ...agent } }),
    send: async (text: string) => { sent.push({ agentId, text }); },
  }) } } };
}
const opening = (env: Record<string, string>, reason = "create") =>
  ({ agentId: "agent-1", workspaceId: null, provider: "codex", cwd: "/work", reason, purpose: "interactive", env });

describe("the agent's model on its way to account selection", () => {
  it("carries the requested model from creation to the new agent's binding, and not into the CLI environment", async () => {
    const before = start();
    const created = await before.get("agent.create")!({ request: { config: { provider: "codex", cwd: "/work", model: "gpt-6.1-sol" }, env: { KEEP: "1" } } }, { paseo: {} });
    expect(created.env).toMatchObject({ KEEP: "1" });
    const opened = await before.get("agent.session_open")!({ request: opening(created.env) }, { paseo: {} });
    expect(controller.bindNewAgent).toHaveBeenCalledWith("agent-1", "codex", "gpt-6.1-sol");
    expect(opened.env).toEqual({ KEEP: "1", CODEX_HOME: "/profiles/work" });
    expect(opened.env).not.toHaveProperty("PASEO_ACCOUNT_SWITCHER_MODEL");
  });
  it("leaves other providers and agents without a chosen model unmarked", async () => {
    const before = start();
    const request = { config: { provider: "opencode", cwd: "/work", model: "m" }, env: {} };
    expect(await before.get("agent.create")!({ request }, { paseo: {} })).toBe(request);
    const unset = await before.get("agent.create")!({ request: { config: { provider: "claude", cwd: "/work" }, env: {} } }, { paseo: {} });
    expect(Object.keys(unset.env ?? {})).toEqual([]);
  });
  it("strips the hint from resumed sessions without binding them", async () => {
    controller.bindNewAgent.mockClear();
    const before = start();
    const created = await before.get("agent.create")!({ request: { config: { provider: "codex", cwd: "/work", model: "gpt-6-luna" }, env: {} } }, { paseo: {} });
    const opened = await before.get("agent.session_open")!({ request: opening(created.env, "resume") }, { paseo: {} });
    expect(controller.bindNewAgent).not.toHaveBeenCalled();
    expect(opened.env).toEqual({ CODEX_HOME: "/profiles/work" });
  });
});

describe("the profile a session's environment names", () => {
  const saved = structuredClone(controller.registry);
  afterEach(() => { Object.assign(controller.registry, structuredClone(saved)); controller.read.mockImplementation(async () => controller.registry); controller.bindNewAgent.mockReset(); controller.bindNewAgent.mockImplementation(async () => undefined); });

  it("tells Paseo which profile a resumed agent runs on, keeping the rest of its environment", async () => {
    const before = start();
    const opened = await before.get("agent.session_open")!({ request: opening({ KEEP: "1", PASEO_ACCOUNT_SWITCHER_MODEL: "gpt-6.1-sol" }, "resume") }, { paseo: {} });
    expect(opened.env).toEqual({ KEEP: "1", CODEX_HOME: "/profiles/work" });
  });
  it("reads the registry after binding, so a new agent gets the profile it was just bound to", async () => {
    controller.registry.bindings = [];
    controller.bindNewAgent.mockImplementationOnce(async () => {
      controller.registry.bindings.push({ agentId: "agent-1", provider: "codex", currentAccountId: null, launchAccountId: "second" });
      return { accountId: "second", defaultId: "second", reason: null };
    });
    const before = start();
    const opened = await before.get("agent.session_open")!({ request: opening({ PASEO_ACCOUNT_SWITCHER_MODEL: "gpt-6.1-sol" }) }, { paseo: {} });
    expect(opened.env).toEqual({ CODEX_HOME: "/profiles/second" });
  });
  it("lets the profile replace a login directory the request already carried", async () => {
    const before = start();
    const opened = await before.get("agent.session_open")!({ request: opening({ CODEX_HOME: "/home/me/.codex" }, "resume") }, { paseo: {} });
    expect(opened.env).toEqual({ CODEX_HOME: "/profiles/work" });
  });
  it("adds nothing for an agent on the system account, nor while integration is off", async () => {
    const before = start();
    controller.registry.bindings = [{ agentId: "agent-1", provider: "codex", currentAccountId: "system-codex", launchAccountId: "system-codex" }];
    expect((await before.get("agent.session_open")!({ request: opening({ KEEP: "1" }, "resume") }, { paseo: {} })).env).toEqual({ KEEP: "1" });
    controller.registry.bindings = [{ agentId: "agent-1", provider: "codex", currentAccountId: "work", launchAccountId: "work" }];
    controller.registry.integration.enabled = false;
    expect((await before.get("agent.session_open")!({ request: opening({ KEEP: "1" }, "resume") }, { paseo: {} })).env).toEqual({ KEEP: "1" });
  });
  it("opens the session without a profile when the registry cannot be read", async () => {
    const before = start(), error = vi.spyOn(console, "error").mockImplementation(() => {});
    controller.read.mockRejectedValue(new Error("registry busy"));
    try {
      const opened = await before.get("agent.session_open")!({ request: opening({ KEEP: "1", PASEO_ACCOUNT_SWITCHER_MODEL: "m" }, "resume") }, { paseo: {} });
      expect(opened.env).toEqual({ KEEP: "1" });
      expect(error).toHaveBeenCalledWith(expect.stringContaining("registry busy"));
    } finally { error.mockRestore(); }
  });
  it("leaves other providers' sessions alone", async () => {
    const before = start();
    const opened = await before.get("agent.session_open")!({ request: { ...opening({ KEEP: "1" }, "resume"), provider: "opencode" } }, { paseo: {} });
    expect(opened.env).toEqual({ KEEP: "1" });
  });
});

describe("account notes in the timeline", () => {
  it("records why a new agent did not start on the default once the agent exists", async () => {
    const { before, on } = startAll(), { appended, paseo } = paseoRecorder();
    controller.bindNewAgent.mockResolvedValueOnce({ accountId: "second", defaultId: "work", reason: "exhausted" });
    await before.get("agent.session_open")!({ request: opening({}) }, { paseo });
    expect(appended).toEqual([]);
    await on.get("agent.created")!({ agent: { id: "agent-1" } }, { paseo });
    await vi.waitFor(() => expect(appended).toHaveLength(1));
    expect(appended[0]).toMatchObject({ agentId: "agent-1", item: { type: "plugin", kind: "account-note", version: 1, data: { kind: "started", from: "Work", to: "Second", reason: "exhausted" } } });
  });
  it("adds no note when the agent starts on its default", async () => {
    const { before, on } = startAll(), { appended, paseo } = paseoRecorder();
    controller.bindNewAgent.mockResolvedValueOnce({ accountId: "work", defaultId: "work", reason: null });
    await before.get("agent.session_open")!({ request: opening({}) }, { paseo });
    await on.get("agent.created")!({ agent: { id: "agent-1" } }, { paseo });
    expect(appended).toEqual([]);
  });
  it("records an applied switch with the account it left", async () => {
    const { handlers } = startAll(), { appended, paseo } = paseoRecorder();
    await handlers.get("switch.apply")!({ agentId: "agent-1" }, { paseo });
    await vi.waitFor(() => expect(appended).toHaveLength(1));
    expect(appended[0].item.data).toEqual({ kind: "switched", from: "Work", to: "Second", reason: null });
  });
});

describe("notes never decide whether a switch succeeded", () => {
  it("names the Current CLI account on an agent's first switch, which has no binding yet", async () => {
    const { handlers } = startAll(), { appended, paseo } = paseoRecorder();
    await handlers.get("switch.apply")!({ agentId: "agent-new" }, { paseo });
    await vi.waitFor(() => expect(appended).toHaveLength(1));
    expect(appended[0].item.data).toMatchObject({ from: "Current CLI · Codex", to: "Second" });
  });
  it("names the account its receipt confirms when the agent's binding was not confirmed yet", async () => {
    const saved = structuredClone(controller.registry.bindings);
    controller.registry.bindings = [{ agentId: "agent-1", provider: "codex", currentAccountId: null, launchAccountId: "work" }];
    controller.receipts.add("agent-1");
    try {
      const { handlers } = startAll(), { appended, paseo } = paseoRecorder();
      await handlers.get("switch.apply")!({ agentId: "agent-1" }, { paseo });
      await vi.waitFor(() => expect(appended).toHaveLength(1));
      expect(appended[0].item.data).toEqual({ kind: "switched", from: "Work", to: "Second", reason: null });
    } finally { controller.registry.bindings = saved; controller.receipts.clear(); }
  });
  it("returns the applied switch when reading labels for its note fails", async () => {
    const { handlers } = startAll(), { appended, paseo } = paseoRecorder();
    controller.read.mockRejectedValue(new Error("registry busy"));
    try {
      await expect(handlers.get("switch.apply")!({ agentId: "agent-1" }, { paseo })).resolves.toMatchObject({ currentAccountId: "second" });
      expect(appended).toEqual([]);
    } finally { controller.read.mockImplementation(async () => controller.registry); }
  });
});

describe("Paseo's Usage view", () => {
  it("registers the Account Switcher source when the daemon has usage sources", async () => {
    const sources: { id: string; discover: (scope: unknown) => Promise<unknown[]> }[] = [];
    contribute({ handle: () => {}, before: () => () => {}, on: () => () => {}, registerUsageSource: (source: any) => { sources.push(source); } } as any);
    expect(sources.map(source => source.id)).toEqual(["account-switcher"]);
    // The mocked registry has no signed-in managed account with an identity, so there is nothing to list.
    await expect(sources[0].discover({ kind: "global" })).resolves.toEqual([]);
  });
  it("starts on a daemon without usage sources", () => {
    expect(() => start()).not.toThrow();
  });
});

describe("a turn that fails on a used-up account", () => {
  const saved = structuredClone(controller.registry);
  const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const reading = (accountId: string, usedPercent: number, provider: UsageSnapshot["provider"] = "codex"): UsageSnapshot => ({
    accountId, provider, status: "ok", plan: null, fetchedAt: null, checkedAt: new Date().toISOString(), nextRetryAt: null, error: null,
    windows: [{ id: "5h", label: "5 hours", usedPercent, windowDurationMins: 300, resetsAt, scope: "account" }],
  });
  const readings = (...items: UsageSnapshot[]) => controller.readings.splice(0, controller.readings.length, ...items);
  const cached = (...items: UsageSnapshot[]) => controller.cached.splice(0, controller.cached.length, ...items);
  const ended = (outcome: object = { kind: "failed", error: { message: "Provider error" } }, agentId = "agent-1", provider = "codex") =>
    ({ agent: { id: agentId, workspaceId: null, parentAgentId: null, provider, cwd: "/work", title: null }, turnId: "turn-7", outcome, timeline: [] });
  // A Claude agent on "Claude Work", with "Claude Second" to switch to.
  const onClaude = () => {
    const managed = controller.registry.accounts[1];
    controller.registry.accounts.push(
      { ...managed, id: "system-claude", label: "Current CLI · Claude", source: "system", provider: "claude", home: "/home/me/.claude" },
      { ...managed, id: "claude-work", label: "Claude Work", provider: "claude", home: "/profiles/claude-work" },
      { ...managed, id: "claude-second", label: "Claude Second", provider: "claude", home: "/profiles/claude-second" });
    controller.registry.bindings = [{ agentId: "agent-1", provider: "claude", currentAccountId: "claude-work", launchAccountId: "claude-work" }];
  };
  // How Paseo reports a Claude turn that hit its limit: the SDK's error result has subtype "success".
  const claudeCompleted = (turnId = "turn-7") => ({ ...ended({ kind: "completed" }, "agent-1", "claude"), turnId });
  // A Claude reading as the plugin's parser builds it from the usage endpoint: the 5-hour window full, and, when given,
  // paid extra usage at `spent` percent of its monthly limit.
  const claudeReading = (accountId: string, spent?: number, fiveHourReset = resetsAt): UsageSnapshot => ({
    accountId, provider: "claude", status: "ok", plan: null, fetchedAt: null, checkedAt: new Date().toISOString(), nextRetryAt: null, error: null,
    windows: parseClaudeUsage({
      five_hour: { utilization: 100, resets_at: fiveHourReset }, seven_day: { utilization: 20, resets_at: fiveHourReset },
      ...(spent === undefined ? {} : { extra_usage: { is_enabled: true, monthly_limit: 50000, used_credits: spent * 500, utilization: spent, currency: "USD", decimal_places: 2 } }),
    }).windows,
  });
  const rowId = "account-failover-agent-1-turn-7";
  const rows = (appended: { item: any }[]) => appended.filter(entry => entry.item.kind === "account-failover").map(entry => entry.item);
  const busy = "Wait for the agent to finish its response.";

  beforeEach(() => { readings(reading("work", 100), reading("second", 10)); cached(); });
  afterEach(() => {
    Object.assign(controller.registry, structuredClone(saved));
    controller.read.mockImplementation(async () => controller.registry);
    controller.apply.mockReset(); controller.apply.mockImplementation(async (agentId: string) => ({ agentId, provider: "codex", currentAccountId: "second" }));
    controller.prepare.mockClear(); controller.switchTo.mockClear(); controller.refresh.mockClear(); controller.list.mockClear(); controller.receipts.clear();
  });

  it("refreshes the agent's account and offers a switch to the account with room", async () => {
    const { on } = startAll(), { appended, sent, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(ended(), { paseo });
    expect(controller.refresh).toHaveBeenCalledWith("work");
    expect(appended).toEqual([{ agentId: "agent-1", item: { type: "plugin", id: rowId, kind: "account-failover", version: 1,
      data: { rowId, state: "offered", from: "Work", fromId: "work", to: "Second", toId: "second", resetsAt, error: null } } }]);
    expect(controller.apply).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
  it("says so when no other account has room", async () => {
    readings(reading("work", 100), reading("second", 100), reading("system-codex", 100));
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(ended(), { paseo });
    expect(rows(appended)).toEqual([expect.objectContaining({ data: expect.objectContaining({ state: "none", from: "Work", to: null, toId: null, resetsAt }) })]);
  });
  it("treats an agent without a binding as running on its provider's Current CLI account", async () => {
    controller.registry.bindings = [];
    readings(reading("system-codex", 100), reading("work", 50), reading("second", 10));
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(ended(), { paseo });
    expect(controller.refresh).toHaveBeenCalledWith("system-codex");
    expect(rows(appended)[0].data).toMatchObject({ state: "offered", from: "Current CLI · Codex", to: "Second", toId: "second" });
  });
  it("adds nothing for a completed Codex turn or a canceled turn, without refreshing anything", async () => {
    // Codex reports a limit stop as a failed turn, so even a used-up account's completed turn is left alone.
    cached(reading("work", 100));
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(ended({ kind: "completed" }), { paseo });
    await on.get("agent.turn_ended")!(ended({ kind: "canceled", reason: "user" }), { paseo });
    onClaude();
    await on.get("agent.turn_ended")!(ended({ kind: "canceled", reason: "user" }, "agent-1", "claude"), { paseo });
    expect(appended).toEqual([]);
    expect(controller.refresh).not.toHaveBeenCalled();
  });

  it("checks a completed Claude turn whose account the last reading shows used up, and offers the switch", async () => {
    onClaude();
    cached(reading("claude-work", 100, "claude"));
    readings(reading("claude-work", 100, "claude"), reading("claude-second", 10, "claude"));
    const { on } = startAll(), { appended, sent, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(claudeCompleted(), { paseo });
    expect(controller.refresh).toHaveBeenCalledWith("claude-work");
    expect(rows(appended).map(item => item.data)).toEqual([{ rowId, state: "offered", from: "Claude Work", fromId: "claude-work", to: "Claude Second", toId: "claude-second", resetsAt, error: null }]);
    expect(controller.apply).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
  it("leaves an ordinary completed Claude turn alone without a provider request", async () => {
    onClaude();
    cached(reading("claude-work", 40, "claude"), reading("claude-second", 10, "claude"));
    readings(reading("claude-work", 100, "claude"), reading("claude-second", 10, "claude"));
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(claudeCompleted(), { paseo });
    // Never read at all is no reason to read either.
    cached();
    await on.get("agent.turn_ended")!(claudeCompleted(), { paseo });
    expect(controller.list).toHaveBeenCalledTimes(2);
    expect(controller.refresh).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
  });
  it("adds nothing for a completed Claude turn when the fresh reading shows room after all", async () => {
    onClaude();
    cached(reading("claude-work", 100, "claude"));
    readings(reading("claude-work", 30, "claude"), reading("claude-second", 10, "claude"));
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(claudeCompleted(), { paseo });
    expect(controller.refresh).toHaveBeenCalledWith("claude-work");
    expect(appended).toEqual([]);
  });
  // With extra usage on, Claude keeps answering past a full 5-hour window, paid from the monthly spend allowance.
  it("leaves a completed Claude turn alone while the account's extra usage has room", async () => {
    onClaude();
    expect(claudeReading("claude-work", 40).windows.map(window => [window.id, window.scope, window.usedPercent])).toEqual([["five_hour", "account", 100], ["seven_day", "account", 20], ["extra_usage", "spend", 40]]);
    cached(claudeReading("claude-work", 40));
    readings(claudeReading("claude-work", 40), reading("claude-second", 10, "claude"));
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(claudeCompleted(), { paseo });
    expect(controller.refresh).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
    // Extra usage turned on since the last reading: the fresh reading says so.
    cached(claudeReading("claude-work"));
    await on.get("agent.turn_ended")!(claudeCompleted("turn-8"), { paseo });
    expect(controller.refresh).toHaveBeenCalledWith("claude-work");
    expect(appended).toEqual([]);
  });
  it("offers the switch on a completed Claude turn once the extra usage is spent too", async () => {
    onClaude();
    cached(claudeReading("claude-work", 100));
    readings(claudeReading("claude-work", 100), reading("claude-second", 10, "claude"));
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(claudeCompleted(), { paseo });
    expect(rows(appended).map(item => item.data)).toEqual([expect.objectContaining({ state: "offered", from: "Claude Work", toId: "claude-second", resetsAt })]);
  });
  it("offers a used-up account once per exhaustion, not after every completed turn", async () => {
    onClaude();
    cached(claudeReading("claude-work"));
    readings(claudeReading("claude-work"), reading("claude-second", 10, "claude"));
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(claudeCompleted("turn-7"), { paseo });
    await on.get("agent.turn_ended")!(claudeCompleted("turn-8"), { paseo });
    expect(rows(appended).map(item => [item.id, item.data.state])).toEqual([[rowId, "offered"]]);
    // The next time the account runs out, with a later reset, is offered again.
    const later = new Date(Date.parse(resetsAt) + 5 * 3_600_000).toISOString();
    cached(claudeReading("claude-work", undefined, later));
    readings(claudeReading("claude-work", undefined, later), reading("claude-second", 10, "claude"));
    await on.get("agent.turn_ended")!(claudeCompleted("turn-9"), { paseo });
    expect(rows(appended).map(item => [item.id, item.data.resetsAt])).toEqual([[rowId, resetsAt], ["account-failover-agent-1-turn-9", later]]);
  });
  it("checks a failed Claude turn as a failed Codex one, without waiting for the last reading", async () => {
    onClaude();
    readings(reading("claude-work", 100, "claude"), reading("claude-second", 10, "claude"));
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(ended(undefined, "agent-1", "claude"), { paseo });
    expect(controller.list).not.toHaveBeenCalled();
    expect(rows(appended).map(item => item.data.state)).toEqual(["offered"]);
  });
  it("switches automatically after a completed Claude turn without asking the agent to continue", async () => {
    onClaude();
    controller.registry.autoFailover.claude = true;
    controller.apply.mockImplementation(async (agentId: string) => ({ agentId, provider: "claude", currentAccountId: "claude-second" }));
    cached(reading("claude-work", 100, "claude"));
    readings(reading("claude-work", 100, "claude"), reading("claude-second", 10, "claude"));
    const { on } = startAll(), { appended, sent, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(claudeCompleted(), { paseo });
    await vi.waitFor(() => expect(rows(appended).at(-1).data.state).toBe("auto"));
    expect(controller.prepare).toHaveBeenCalledWith("agent-1", "claude-second");
    expect(controller.apply).toHaveBeenCalledWith("agent-1", "claude-second");
    expect(rows(appended).map(item => item.data.state)).toEqual(["switching", "auto"]);
    // The turn may have ended for real, so nothing is sent; the row says where the next message runs.
    expect(rows(appended).at(-1).data).toEqual({ rowId, state: "auto", from: "Claude Work", fromId: "claude-work", to: "Claude Second", toId: "claude-second", resetsAt, error: null, resumes: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
    expect(appended.filter(entry => entry.item.kind !== "account-failover")).toEqual([]);
  });
  // An agent started with no app open has an unconfirmed binding until something reads its launch receipt.
  it("offers the switch for an agent whose launch only its receipt confirms", async () => {
    controller.registry.bindings = [{ agentId: "agent-1", provider: "codex", currentAccountId: null, launchAccountId: "work" }];
    controller.receipts.add("agent-1");
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(ended(), { paseo });
    expect(controller.refresh).toHaveBeenCalledWith("work");
    expect(rows(appended).map(item => item.data)).toEqual([expect.objectContaining({ state: "offered", from: "Work", to: "Second", toId: "second" })]);
  });
  it("adds nothing for an agent whose account nothing confirms", async () => {
    controller.registry.bindings = [{ agentId: "agent-1", provider: "codex", currentAccountId: null, launchAccountId: "work" }];
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(ended(), { paseo });
    expect(controller.refresh).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
  });
  it("adds nothing when the readings do not show the account used up", async () => {
    readings(reading("work", 80), reading("second", 10));
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(ended(), { paseo });
    expect(appended).toEqual([]);
  });
  it("adds nothing while integration is off, or off for the agent's provider", async () => {
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    controller.registry.integration.enabled = false;
    await on.get("agent.turn_ended")!(ended(), { paseo });
    controller.registry.integration = { enabled: true, error: null, providers: ["claude"] };
    await on.get("agent.turn_ended")!(ended(), { paseo });
    expect(appended).toEqual([]);
    expect(controller.refresh).not.toHaveBeenCalled();
  });
  it("never throws out of the hook when the registry cannot be read", async () => {
    const { on } = startAll(), { appended, paseo } = paseoRecorder(), error = vi.spyOn(console, "error").mockImplementation(() => {});
    controller.read.mockRejectedValue(new Error("registry busy"));
    try {
      await expect(on.get("agent.turn_ended")!(ended(), { paseo })).resolves.toBeUndefined();
      expect(appended).toEqual([]);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("registry busy"));
    } finally { error.mockRestore(); }
  });

  it("switches automatically when that is on for the provider, then asks the agent to continue", async () => {
    controller.registry.autoFailover.codex = true;
    const { on } = startAll(), { appended, sent, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(ended(), { paseo });
    // The switch outlasts Paseo's hook timeout, so it runs on after the hook returns.
    await vi.waitFor(() => expect(sent).toEqual([{ agentId: "agent-1", text: "Continue." }]));
    // One select-and-apply step, so a refused attempt leaves no selection behind.
    expect(controller.switchTo).toHaveBeenCalledWith("agent-1", "second");
    expect(controller.apply).toHaveBeenCalledWith("agent-1", "second");
    expect(rows(appended).every(item => item.id === rowId)).toBe(true);
    expect(rows(appended).map(item => item.data.state)).toEqual(["switching", "auto"]);
    expect(rows(appended).at(-1).data).toEqual({ rowId, state: "auto", from: "Work", fromId: "work", to: "Second", toId: "second", resetsAt, error: null });
    // The failover row carries the outcome; no separate "Account switched" note.
    expect(appended.filter(entry => entry.item.kind !== "account-failover")).toEqual([]);
  });
  it("leaves the switch to the user while automatic switching is off for that provider", async () => {
    controller.registry.autoFailover.claude = true;
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(ended(), { paseo });
    expect(controller.apply).not.toHaveBeenCalled();
    expect(rows(appended).map(item => item.data.state)).toEqual(["offered"]);
  });
  it("shows the switch service's refusal when an automatic switch cannot be applied", async () => {
    controller.registry.autoFailover.codex = true;
    controller.apply.mockRejectedValue(new SwitchRefusal(busy));
    const { on } = startAll(), { appended, sent, paseo } = paseoRecorder(), error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(on.get("agent.turn_ended")!(ended(), { paseo })).resolves.toBeUndefined();
      await vi.waitFor(() => expect(rows(appended).at(-1).data).toMatchObject({ rowId, state: "failed", to: "Second", error: busy }));
      // Logged once the failure reaches the hook's handler, a few ticks after the row.
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining(busy)));
      expect(sent).toEqual([]);
    } finally { error.mockRestore(); }
  });
  it("stops switching automatically after three switches of one agent within the hour", async () => {
    controller.registry.autoFailover.codex = true;
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    for (const turnId of ["t1", "t2", "t3", "t4"]) {
      // Every turn fails on a fresh account, so only the hourly limit can stop the fourth switch.
      const from = `from-${turnId}`, to = `to-${turnId}`;
      controller.registry.accounts.push({ ...saved.accounts[1], id: from, label: from }, { ...saved.accounts[1], id: to, label: to });
      controller.registry.bindings = [{ agentId: "agent-1", provider: "codex", currentAccountId: from, launchAccountId: from }];
      readings(reading(from, 100), reading(to, 0), reading("work", 100), reading("second", 100));
      await on.get("agent.turn_ended")!({ ...ended(), turnId }, { paseo });
      // Each switch settles before the next turn fails; one still under way would stop the next on its own.
      await vi.waitFor(() => expect(rows(appended).at(-1).data.state).toMatch(/^(auto|offered)$/));
    }
    expect(controller.apply).toHaveBeenCalledTimes(3);
    expect(rows(appended).filter(item => item.id === "account-failover-agent-1-t4").map(item => item.data.state)).toEqual(["offered"]);
  });

  it("leaves an unresolved automatic switch alone when the turn is reported again, with or without its id", async () => {
    controller.registry.autoFailover.codex = true;
    let finish!: () => void;
    controller.apply.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ agentId: "agent-1", provider: "codex", currentAccountId: "second" }); }));
    const { on } = startAll(), { appended, sent, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(ended(), { paseo });
    await vi.waitFor(() => expect(controller.apply).toHaveBeenCalledOnce());
    await on.get("agent.turn_ended")!(ended(), { paseo });
    await on.get("agent.turn_ended")!({ ...ended(), turnId: null }, { paseo });
    expect(rows(appended).map(item => [item.id, item.data.state])).toEqual([[rowId, "switching"]]);
    expect(controller.refresh).toHaveBeenCalledOnce();
    finish();
    await vi.waitFor(() => expect(sent).toEqual([{ agentId: "agent-1", text: "Continue." }]));
    // Once switched, the same turn reported again adds nothing: the row keeps saying it switched.
    await on.get("agent.turn_ended")!(ended(), { paseo });
    expect(rows(appended).map(item => [item.id, item.data.state])).toEqual([[rowId, "switching"], [rowId, "auto"]]);
    expect(controller.prepare).toHaveBeenCalledOnce();
    expect(controller.apply).toHaveBeenCalledOnce();
  });
  it("adds nothing while the agent's account is being switched elsewhere", async () => {
    controller.registry.bindings = [{ agentId: "agent-1", provider: "codex", currentAccountId: "work", launchAccountId: "second", status: "switching" }];
    const { on } = startAll(), { appended, paseo } = paseoRecorder();
    await on.get("agent.turn_ended")!(ended(), { paseo });
    expect(appended).toEqual([]);
    expect(controller.refresh).not.toHaveBeenCalled();
  });
  it("refuses a second click while the first switch is under way, leaving its row as it is", async () => {
    let finish!: () => void;
    controller.apply.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ agentId: "agent-1", provider: "codex", currentAccountId: "second" }); }));
    const { handlers } = startAll(), { appended, paseo } = paseoRecorder();
    const first = handlers.get("failover.apply")!({ agentId: "agent-1", accountId: "second", rowId }, { paseo });
    await vi.waitFor(() => expect(controller.apply).toHaveBeenCalledOnce());
    await expect(handlers.get("failover.apply")!({ agentId: "agent-1", accountId: "second", rowId }, { paseo })).rejects.toThrow("An account switch is already in progress.");
    expect(rows(appended).map(item => item.data.state)).toEqual(["switching"]);
    finish();
    await expect(first).resolves.toEqual({});
    expect(rows(appended).map(item => item.data.state)).toEqual(["switching", "switched"]);
  });

  it("applies the offered switch from the row's button and asks the agent to continue", async () => {
    const { handlers } = startAll(), { appended, sent, paseo } = paseoRecorder();
    await expect(handlers.get("failover.apply")!({ agentId: "agent-1", accountId: "second", rowId, fromId: "work" }, { paseo })).resolves.toEqual({});
    expect(controller.switchTo).toHaveBeenCalledWith("agent-1", "second");
    expect(controller.apply).toHaveBeenCalledWith("agent-1", "second");
    expect(sent).toEqual([{ agentId: "agent-1", text: "Continue." }]);
    expect(rows(appended).every(item => item.id === rowId)).toBe(true);
    expect(rows(appended).at(-1).data).toMatchObject({ rowId, state: "switched", from: "Work", fromId: "work", to: "Second", toId: "second", error: null });
    expect(appended.filter(entry => entry.item.kind !== "account-failover")).toEqual([]);
  });
  it("applies the offer of a row from before it named the account it moves from", async () => {
    const { handlers } = startAll(), { appended, paseo } = paseoRecorder();
    await expect(handlers.get("failover.apply")!({ agentId: "agent-1", accountId: "second", rowId }, { paseo })).resolves.toEqual({});
    expect(rows(appended).at(-1).data).toMatchObject({ state: "switched", from: "Work", to: "Second" });
  });
  it("refuses an offer that is out of date because the agent moved to another account since", async () => {
    controller.registry.bindings = [{ agentId: "agent-1", provider: "codex", currentAccountId: "system-codex", launchAccountId: "system-codex" }];
    const { handlers } = startAll(), { appended, sent, paseo } = paseoRecorder();
    const stale = "This offer is out of date: the agent now runs on Current CLI · Codex.";
    await expect(handlers.get("failover.apply")!({ agentId: "agent-1", accountId: "second", rowId, fromId: "work" }, { paseo })).rejects.toThrow(stale);
    expect(controller.switchTo).not.toHaveBeenCalled();
    expect(rows(appended).map(item => item.data)).toEqual([expect.objectContaining({ rowId, state: "failed", to: "Second", error: stale })]);
    expect(sent).toEqual([]);
  });
  it("refuses an offer of the account the agent already runs on", async () => {
    controller.registry.bindings = [{ agentId: "agent-1", provider: "codex", currentAccountId: "second", launchAccountId: "second" }];
    const { handlers } = startAll(), { appended, paseo } = paseoRecorder();
    const already = "The agent already runs on Second.";
    // A row from before it named its account gets the same answer.
    for (const fromId of ["work", undefined]) {
      await expect(handlers.get("failover.apply")!({ agentId: "agent-1", accountId: "second", rowId, fromId }, { paseo })).rejects.toThrow(already);
    }
    expect(controller.switchTo).not.toHaveBeenCalled();
    expect(rows(appended).map(item => item.data)).toEqual([0, 1].map(() => expect.objectContaining({ state: "failed", error: already })));
  });
  it("shows a generic sentence in the row for an unexpected failure, and logs the detail", async () => {
    const raw = Object.assign(new Error("EACCES: permission denied, open '/Users/me/.paseo/account-switcher/registry.json'"), { code: "EACCES" });
    controller.apply.mockRejectedValue(raw);
    const { handlers } = startAll(), { appended, sent, paseo } = paseoRecorder(), error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const outcome = handlers.get("failover.apply")!({ agentId: "agent-1", accountId: "second", rowId, fromId: "work" }, { paseo });
      await expect(outcome).rejects.toThrow("The switch failed; the plugin log has details.");
      expect(rows(appended).at(-1).data).toMatchObject({ state: "failed", error: "The switch failed; the plugin log has details." });
      expect(JSON.stringify(appended)).not.toContain("/Users/me");
      expect(error).toHaveBeenCalledWith(expect.stringContaining("EACCES: permission denied, open '/Users/me/.paseo/account-switcher/registry.json'"));
      expect(sent).toEqual([]);
    } finally { error.mockRestore(); }
  });
  it("answers the button with the generic sentence when checking the offer fails unexpectedly", async () => {
    const raw = new Error("EACCES: permission denied, open '/Users/me/.paseo/account-switcher/registry.json'");
    const { handlers } = startAll(), { appended, paseo } = paseoRecorder(), error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      controller.read.mockRejectedValueOnce(raw);
      await expect(handlers.get("failover.apply")!({ agentId: "agent-1", accountId: "second", rowId, fromId: "work" }, { paseo })).rejects.toThrow(/^The switch failed; the plugin log has details\.$/);
      controller.accountOf.mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'bindings')"));
      await expect(handlers.get("failover.apply")!({ agentId: "agent-1", accountId: "second", rowId, fromId: "work" }, { paseo })).rejects.toThrow(/^The switch failed; the plugin log has details\.$/);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("EACCES: permission denied, open '/Users/me/.paseo/account-switcher/registry.json'"));
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Cannot read properties of undefined (reading 'bindings')"));
      expect(controller.switchTo).not.toHaveBeenCalled();
      expect(appended).toEqual([]);
      // The plugin's own answers still reach the user as they are.
      await expect(handlers.get("failover.apply")!({ agentId: "agent-1", accountId: "missing", rowId }, { paseo })).rejects.toThrow(/^Account not found\.$/);
      await expect(handlers.get("failover.apply")!({ agentId: "agent-2", accountId: "second", rowId }, { paseo })).rejects.toThrow(/^The switch offer belongs to another agent\.$/);
    } finally { error.mockRestore(); }
  });
  it("keeps an unexpected failure of an automatic switch out of the row too", async () => {
    controller.registry.autoFailover.codex = true;
    controller.apply.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'agent')"));
    const { on } = startAll(), { appended, paseo } = paseoRecorder(), error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await on.get("agent.turn_ended")!(ended(), { paseo });
      await vi.waitFor(() => expect(rows(appended).at(-1).data).toMatchObject({ state: "failed", error: "The switch failed; the plugin log has details." }));
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Cannot read properties of undefined"));
      expect(JSON.stringify(rows(appended))).not.toContain("Cannot read");
    } finally { error.mockRestore(); }
  });
  it("turns the row into the refusal when the agent started another turn or waits for a permission", async () => {
    controller.apply.mockRejectedValue(new SwitchRefusal(busy));
    const { handlers } = startAll(), { appended, sent, paseo } = paseoRecorder();
    await expect(handlers.get("failover.apply")!({ agentId: "agent-1", accountId: "second", rowId }, { paseo })).rejects.toThrow(busy);
    expect(rows(appended).at(-1).data).toMatchObject({ rowId, state: "failed", to: "Second", error: busy });
    expect(sent).toEqual([]);
  });
  it("applies the button's switch for an agent whose launch only its receipt confirms", async () => {
    controller.registry.bindings = [{ agentId: "agent-1", provider: "codex", currentAccountId: null, launchAccountId: "work" }];
    controller.receipts.add("agent-1");
    const { handlers } = startAll(), { appended, sent, paseo } = paseoRecorder();
    await expect(handlers.get("failover.apply")!({ agentId: "agent-1", accountId: "second", rowId }, { paseo })).resolves.toEqual({});
    expect(controller.apply).toHaveBeenCalledWith("agent-1", "second");
    expect(rows(appended).at(-1).data).toMatchObject({ state: "switched", from: "Work", to: "Second" });
    expect(sent).toEqual([{ agentId: "agent-1", text: "Continue." }]);
  });
  it("refuses the button's switch, saying why, when nothing confirms the agent's account", async () => {
    controller.registry.bindings = [{ agentId: "agent-1", provider: "codex", currentAccountId: null, launchAccountId: "work" }];
    const { handlers } = startAll(), { appended, paseo } = paseoRecorder();
    const outcome = handlers.get("failover.apply")!({ agentId: "agent-1", accountId: "second", rowId }, { paseo });
    await expect(outcome).rejects.toThrow("This agent's account is not confirmed yet.");
    await expect(outcome).rejects.not.toThrow("Account not found.");
    expect(controller.prepare).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
  });
  it("refuses a row that belongs to another agent", async () => {
    const { handlers } = startAll(), { appended, paseo } = paseoRecorder();
    await expect(handlers.get("failover.apply")!({ agentId: "agent-2", accountId: "second", rowId }, { paseo })).rejects.toThrow();
    expect(controller.apply).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
  });

  it("saves the automatic switching choice per provider", async () => {
    const { handlers } = startAll();
    await expect(handlers.get("accounts.auto-failover")!({ provider: "codex", enabled: true }, { paseo: {} })).resolves.toEqual({});
    expect(controller.registry.autoFailover).toEqual({ claude: false, codex: true });
  });
});
