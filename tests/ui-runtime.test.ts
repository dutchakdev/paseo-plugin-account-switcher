import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaseoAgent, PaseoAgentUpdate } from "@getpaseo/client";
import type { PluginClientContext, PluginComposerPillContribution } from "@getpaseo/plugin/client";
import type { AccountState } from "../shared/contracts";
import { createClientRuntime } from "../client/runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

const agent = { id: "agent-1", workspaceId: "workspace-1", provider: "claude", status: "idle", archivedAt: null } as PaseoAgent;
const page = { entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } };
const state: AccountState = {
  accounts: [
    { id: "system-claude", provider: "claude", source: "system", label: "System", authStatus: "ready", email: null, plan: null, createdAt: "2026-09-15" },
    { id: "account-2", provider: "claude", source: "managed", label: "Team", authStatus: "ready", email: null, plan: null, createdAt: "2026-09-15" },
  ],
  bindings: [{ agentId: agent.id, provider: "claude", currentAccountId: "system-claude", pendingAccountId: "account-2", status: "ready", error: null }],
  defaults: { claude: null, codex: null }, integration: { enabled: true, error: null },
};

function harness(listResult: Promise<unknown> = Promise.resolve(page), accountState = state) {
  let listener: (update: PaseoAgentUpdate) => void = () => {};
  const remove = vi.fn();
  const update = vi.fn();
  const add = vi.fn((_contribution: PluginComposerPillContribution) => ({ update, remove }));
  const unsubscribe = vi.fn();
  const context = {
    paseo: { agents: {
      subscribe: vi.fn((callback: typeof listener) => { listener = callback; return unsubscribe; }),
      list: vi.fn(() => listResult),
    } },
    rpc: vi.fn(async (contract: { name: string }) => contract.name === "accounts.list" ? accountState : { accounts: [] }),
    addComposerPill: add,
  } as unknown as PluginClientContext;
  return { context, add, update, remove, unsubscribe, emit: (event: PaseoAgentUpdate) => listener(event) };
}

afterEach(() => vi.useRealTimers());

describe("composer registration lifecycle", () => {
  it("does not label an unconfirmed session as the system account", async () => {
    vi.useFakeTimers();
    const unknown = structuredClone(state);
    unknown.bindings[0].currentAccountId = null;
    unknown.bindings[0].status = "error";
    const host = harness(Promise.resolve(page), unknown);
    const runtime = createClientRuntime(host.context, () => null);
    await flush();
    const label = host.update.mock.lastCall?.[0].label ?? host.add.mock.lastCall?.[0]?.button.label;
    expect(label).toContain("Account not confirmed");
    expect(label).not.toContain("System");
    runtime.stop();
  });
  it("labels the actual account while another account is prepared", async () => {
    vi.useFakeTimers();
    const host = harness();
    const runtime = createClientRuntime(host.context, () => null);
    await flush();
    const label = host.update.mock.lastCall?.[0].label ?? host.add.mock.lastCall?.[0]?.button.label;
    expect(label).toContain("System");
    expect(label).not.toContain("Team");
    expect(label).toContain("→");
    runtime.stop();
    expect(host.remove).toHaveBeenCalledOnce();
    expect(host.unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not resurrect an agent removed while its initial directory request is pending", async () => {
    vi.useFakeTimers();
    const initial = deferred<unknown>();
    const host = harness(initial.promise);
    const runtime = createClientRuntime(host.context, () => null);
    host.emit({ kind: "remove", agentId: agent.id });
    initial.resolve(page);
    await flush();
    expect(host.add).not.toHaveBeenCalled();
    runtime.stop();
  });

  it("ignores late bootstrap results and future timer ticks after disposal", async () => {
    vi.useFakeTimers();
    const initial = deferred<unknown>();
    const host = harness(initial.promise);
    const runtime = createClientRuntime(host.context, () => null);
    runtime.stop();
    initial.resolve(page);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.add).not.toHaveBeenCalled();
    expect(host.context.paseo.agents.list).toHaveBeenCalledOnce();
  });

  it("exposes registration discovery failures instead of swallowing them", async () => {
    vi.useFakeTimers();
    const host = harness(Promise.reject(new Error("Host disconnected")));
    const runtime = createClientRuntime(host.context, () => null);
    await flush();
    expect(runtime.getError()).toContain("Host disconnected");
    runtime.stop();
  });
});
