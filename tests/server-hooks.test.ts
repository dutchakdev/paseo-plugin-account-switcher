import { describe, expect, it, vi } from "vitest";

const controller = vi.hoisted(() => {
  const bindNewAgent = vi.fn(async () => {});
  return {
    bindNewAgent,
    instance: { ready: Promise.resolve(), ensureRuntime: vi.fn(async () => {}), switcher: () => ({ bindNewAgent }), close: vi.fn(async () => {}), observeAgentRegistration: vi.fn() },
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
