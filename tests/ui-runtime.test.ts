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
const page = { entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } } as Awaited<ReturnType<PluginClientContext["paseo"]["agents"]["list"]>>;
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
  it("lets the host assign the observation ID and releases it once on disposal", async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    const host = harness();
    vi.mocked(host.context.paseo.agents.list).mockImplementation(async (options) => {
      if (options?.subscribe && "subscriptionId" in options.subscribe) {
        throw new Error("Subscription IDs are assigned by the host");
      }
      return { ...page, requestId: "request", ...(options?.subscribe ? { subscription: { release } } : {}) };
    });
    const runtime = createClientRuntime(host.context, () => null);
    await flush();
    expect(runtime.getError()).toBeNull();
    expect(host.add).toHaveBeenCalledOnce();
    host.emit({ kind: "upsert", agent: { ...agent, id: "agent-2" } });
    expect(host.add).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    runtime.refresh(); await flush();
    const calls = vi.mocked(host.context.paseo.agents.list).mock.calls;
    expect(calls.filter(([options]) => options?.subscribe)).toHaveLength(1);
    expect(calls[0][0]?.subscribe).toEqual({});
    expect(release).not.toHaveBeenCalled();
    runtime.stop(); runtime.stop();
    expect(release).toHaveBeenCalledOnce();
  });

  it("paginates without creating more observations or replacing the live filter", async () => {
    vi.useFakeTimers();
    const host = harness();
    vi.mocked(host.context.paseo.agents.list)
      .mockResolvedValueOnce({ ...page, requestId: "first", pageInfo: { ...page.pageInfo, hasMore: true, nextCursor: "next" } })
      .mockResolvedValueOnce({ entries: [{ ...page.entries[0], agent: { ...agent, id: "agent-2" } }], requestId: "second", pageInfo: page.pageInfo });
    const runtime = createClientRuntime(host.context, () => null);
    await flush();
    expect(host.add).toHaveBeenCalledTimes(2);
    expect(host.context.paseo.agents.list).toHaveBeenNthCalledWith(2, { scope: "active", page: { limit: 100, cursor: "next" } });
    runtime.stop();
  });

  it("releases an observation returned after disposal", async () => {
    vi.useFakeTimers();
    const initial = deferred<unknown>();
    const release = vi.fn(async () => {});
    const host = harness(initial.promise);
    const runtime = createClientRuntime(host.context, () => null);
    runtime.stop();
    initial.resolve({ ...page, subscription: { release } });
    await flush();
    expect(release).toHaveBeenCalledOnce();
    expect(host.add).not.toHaveBeenCalled();
  });

  it("retries observation setup after a failed directory request", async () => {
    vi.useFakeTimers();
    const host = harness(Promise.reject(new Error("Host disconnected")));
    const runtime = createClientRuntime(host.context, () => null);
    await flush();
    vi.mocked(host.context.paseo.agents.list).mockResolvedValue({ ...page, requestId: "retry" });
    runtime.refresh(); await flush();
    expect(runtime.getError()).toBeNull();
    expect(host.add).toHaveBeenCalledOnce();
    expect(vi.mocked(host.context.paseo.agents.list).mock.lastCall?.[0]?.subscribe).toEqual({});
    runtime.stop();
  });

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
