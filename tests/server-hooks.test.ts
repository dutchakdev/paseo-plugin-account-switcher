import { describe, expect, it, vi } from "vitest";

const controller = vi.hoisted(() => {
  const bindNewAgent = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
  const apply = vi.fn(async (agentId: string) => ({ agentId, provider: "codex", currentAccountId: "second" }));
  const registry = {
    accounts: [{ id: "system-codex", label: "Current CLI · Codex", source: "system", provider: "codex" }, { id: "work", label: "Work", source: "managed", provider: "codex" }, { id: "second", label: "Second", source: "managed", provider: "codex" }],
    bindings: [{ agentId: "agent-1", currentAccountId: "work" }],
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
    expect(opened.env).toEqual({ KEEP: "1" });
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
    expect(opened.env).toEqual({});
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
