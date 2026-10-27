import { afterEach, describe, expect, it, vi } from "vitest";

const controller = vi.hoisted(() => {
  const bindNewAgent = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
  const apply = vi.fn(async (agentId: string) => ({ agentId, provider: "codex", currentAccountId: "second" }));
  const registry = {
    accounts: [{ id: "system-codex", label: "Current CLI · Codex", source: "system", provider: "codex", home: "/home/me/.codex" }, { id: "work", label: "Work", source: "managed", provider: "codex", home: "/profiles/work" }, { id: "second", label: "Second", source: "managed", provider: "codex", home: "/profiles/second" }],
    bindings: [{ agentId: "agent-1", provider: "codex", currentAccountId: "work", launchAccountId: "work" }] as { agentId: string; provider: string; currentAccountId: string | null; launchAccountId: string | null }[],
    integration: { enabled: true, error: null, providers: ["claude", "codex"] },
  };
  const read = vi.fn(async () => registry);
  return {
    bindNewAgent, apply, read, registry,
    instance: { ready: Promise.resolve(), ensureRuntime: vi.fn(async () => {}), switcher: () => ({ bindNewAgent, apply }), close: vi.fn(async () => {}),
      observeAgentRegistration: vi.fn(), store: { read }, usage: { refresh: vi.fn(async () => []) } },
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
function paseoRecorder() {
  const appended: { agentId: string; item: any }[] = [];
  return { appended, paseo: { agents: { ref: (agentId: string) => ({ timeline: { append: async (item: unknown) => { appended.push({ agentId, item }); return {}; } } }) } } };
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
