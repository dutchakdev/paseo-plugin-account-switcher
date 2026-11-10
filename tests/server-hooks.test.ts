import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageSnapshot } from "../shared/contracts";
import { SwitchRefusal } from "../server/switching";
import { ContinuationCoordinator } from "../server/continuation";

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
  const checksEnabled = vi.fn(async () => true);
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
    bindNewAgent, apply, prepare, switchTo, read, change, refresh, readings, list, cached, checksEnabled, receipts, accountOf, registry,
    instance: { ready: Promise.resolve(), ensureRuntime: vi.fn(async () => {}), switcher: () => ({ bindNewAgent, apply, prepare, switchTo }), close: vi.fn(async () => {}),
      observeAgentRegistration: vi.fn(), store: { root: "/unused-test-account-store", read, change }, usage: { refresh, list, checksEnabled }, accountOf },
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
    subscribe: () => () => {},
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
    expect(controller.bindNewAgent).toHaveBeenCalledWith("agent-1", "codex", "gpt-6.1-sol", null);
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

describe("an account named when the agent is created", () => {
  afterEach(() => { controller.bindNewAgent.mockReset(); controller.bindNewAgent.mockImplementation(async () => undefined); });
  it("hands the named account to the new agent's binding, and not to the CLI environment", async () => {
    const before = start();
    const created = await before.get("agent.create")!({ request: { config: { provider: "codex", cwd: "/work" }, env: { KEEP: "1", PASEO_ACCOUNT_SWITCHER_ACCOUNT: " Second " } } }, { paseo: {} });
    const opened = await before.get("agent.session_open")!({ request: opening(created.env) }, { paseo: {} });
    expect(controller.bindNewAgent).toHaveBeenCalledWith("agent-1", "codex", null, "Second");
    expect(opened.env).not.toHaveProperty("PASEO_ACCOUNT_SWITCHER_ACCOUNT");
    expect(opened.env).toMatchObject({ KEEP: "1" });
  });
  it("treats an empty value as no account named", async () => {
    await start().get("agent.session_open")!({ request: opening({ PASEO_ACCOUNT_SWITCHER_ACCOUNT: "  " }) }, { paseo: {} });
    expect(controller.bindNewAgent).toHaveBeenCalledWith("agent-1", "codex", null, null);
  });
  it("strips the name from later sessions of the agent without binding them", async () => {
    const opened = await start().get("agent.session_open")!({ request: opening({ PASEO_ACCOUNT_SWITCHER_ACCOUNT: "Second" }, "resume") }, { paseo: {} });
    expect(controller.bindNewAgent).not.toHaveBeenCalled();
    expect(opened.env).not.toHaveProperty("PASEO_ACCOUNT_SWITCHER_ACCOUNT");
  });
  it("refuses to create an agent of a provider whose accounts the plugin does not manage", async () => {
    const request = { ...opening({ PASEO_ACCOUNT_SWITCHER_ACCOUNT: "Second" }), provider: "opencode" };
    await expect(start().get("agent.session_open")!({ request }, { paseo: {} })).rejects.toThrow(SwitchRefusal);
    await expect(start().get("agent.session_open")!({ request }, { paseo: {} })).rejects.toThrow("Account Switcher manages only Claude Code and Codex accounts, so the opencode agent cannot start on Second.");
    expect(controller.bindNewAgent).not.toHaveBeenCalled();
  });
  it("lets a refused binding fail the creation with its reason", async () => {
    controller.bindNewAgent.mockRejectedValueOnce(new SwitchRefusal("No Codex account is named Nobody."));
    await expect(start().get("agent.session_open")!({ request: opening({ PASEO_ACCOUNT_SWITCHER_ACCOUNT: "Nobody" }) }, { paseo: {} })).rejects.toThrow("No Codex account is named Nobody.");
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
  it("records that a new agent starts on the account named at its creation", async () => {
    const { before, on } = startAll(), { appended, paseo } = paseoRecorder();
    controller.bindNewAgent.mockResolvedValueOnce({ accountId: "second", defaultId: "work", reason: "requested" });
    await before.get("agent.session_open")!({ request: opening({ PASEO_ACCOUNT_SWITCHER_ACCOUNT: "Second" }) }, { paseo });
    await on.get("agent.created")!({ agent: { id: "agent-1" } }, { paseo });
    await vi.waitFor(() => expect(appended).toHaveLength(1));
    expect(appended[0]).toMatchObject({ item: { kind: "account-note", data: { kind: "started", from: "Work", to: "Second", reason: "requested" } } });
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

describe("quota continuation lifecycle wiring", () => {
  it("observes turn starts synchronously and delegates turn outcomes", async () => {
    const started = vi.spyOn(ContinuationCoordinator.prototype, "started");
    const ended = vi.spyOn(ContinuationCoordinator.prototype, "ended");
    const { on } = startAll(), { paseo } = paseoRecorder();
    const event = { agent: { id: "agent-1", provider: "codex", cwd: "/work", parentAgentId: null }, turnId: "turn", outcome: { kind: "completed" } };
    try {
      on.get("agent.turn_started")!(event, { paseo });
      expect(started).toHaveBeenCalledWith(event, paseo);
      await on.get("agent.turn_ended")!(event, { paseo });
      expect(ended).toHaveBeenCalledWith(event, paseo);
    } finally { started.mockRestore(); ended.mockRestore(); }
  });
  it("invalidates pending recovery on permissions, archives and manual selections", async () => {
    const invalidated = vi.spyOn(ContinuationCoordinator.prototype, "invalidate");
    const { on, handlers } = startAll(), { paseo } = paseoRecorder();
    try {
      on.get("agent.permission_requested")!({ agent: { id: "agent-1" } }, { paseo });
      on.get("agent.archived")!({ agent: { id: "agent-1" } }, { paseo });
      await handlers.get("switch.prepare")!({ agentId: "agent-1", accountId: "second" }, { paseo });
      expect(invalidated.mock.calls.filter(([id]) => id === "agent-1")).toHaveLength(3);
    } finally { invalidated.mockRestore(); }
  });
  it("refuses old and forged recovery rows instead of reconstructing an offer", async () => {
    const { handlers } = startAll(), { paseo, sent } = paseoRecorder();
    await expect(handlers.get("failover.apply")!({ agentId: "agent-1", accountId: "second", rowId: "account-failover-agent-1-old" }, { paseo })).rejects.toThrow(/\/account/);
    expect(sent).toEqual([]);
  });
  it("saves the automatic switching choice per provider", async () => {
    const before = structuredClone(controller.registry.autoFailover);
    try {
      const { handlers } = startAll();
      await expect(handlers.get("accounts.auto-failover")!({ provider: "codex", enabled: true }, { paseo: {} })).resolves.toEqual({});
      expect(controller.registry.autoFailover.codex).toBe(true);
    } finally { controller.registry.autoFailover = before; }
  });
});
