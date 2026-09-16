import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaseoAgent, PaseoAgentUpdate } from "@getpaseo/client";
import type { PluginClientContext, PluginComposerPillContribution } from "@getpaseo/plugin/client";
import { createClientRuntime } from "../client/runtime";

async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
const agent = (id: string, workspaceId = "workspace"): PaseoAgent => ({ id, workspaceId, provider: "codex", status: "idle", archivedAt: null } as PaseoAgent);

async function harness() {
  vi.useFakeTimers();
  let emit: (update: PaseoAgentUpdate) => void = () => {};
  const buttons: PluginComposerPillContribution[] = [];
  const context = {
    paseo: { agents: {
      subscribe: (listener: typeof emit) => { emit = listener; return vi.fn(); },
      list: async () => ({ entries: [agent("first"), agent("second")].map(agent => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
    } },
    rpc: vi.fn(async (contract: { name: string }) => contract.name === "accounts.list"
      ? { accounts: [], bindings: [], defaults: { claude: null, codex: null }, integration: { enabled: true, error: null } }
      : { accounts: [] }),
    addComposerPill: (contribution: PluginComposerPillContribution) => { buttons.push(contribution); return { update: vi.fn(), remove: vi.fn() }; },
  } as unknown as PluginClientContext;
  const runtime = createClientRuntime(context, () => null);
  await flush();
  const press = (index: number) => { const behavior = buttons[index].button.behavior; if (behavior.kind === "action") return behavior.onPress(); };
  return { runtime, press, emit: (update: PaseoAgentUpdate) => emit(update) };
}

afterEach(() => vi.useRealTimers());

describe("account modal target ownership", () => {
  it("keeps a newer agent's modal open when an older dialog dismisses late", async () => {
    const { runtime, press } = await harness();
    await press(0); const first = runtime.getModalTarget()!;
    await press(1); const second = runtime.getModalTarget()!;
    expect(second.agentId).toBe("second");
    runtime.closeModal(first);
    expect(runtime.getModalTarget()).toBe(second);
    runtime.closeModal(second);
    expect(runtime.getModalTarget()).toBeNull();
    runtime.stop();
  });

  it("ignores duplicate presses and old dismissals after reopening the same agent", async () => {
    const { runtime, press } = await harness();
    await press(0); const first = runtime.getModalTarget()!;
    await press(0); expect(runtime.getModalTarget()).toBe(first);
    runtime.closeModal(first); await press(0);
    const reopened = runtime.getModalTarget()!;
    expect(reopened).toEqual(first); expect(reopened).not.toBe(first);
    runtime.closeModal(first); expect(runtime.getModalTarget()).toBe(reopened);
    runtime.stop();
  });

  it("closes a removed agent's modal and ignores its stale press handler", async () => {
    const { runtime, press, emit } = await harness();
    await press(0);
    emit({ kind: "remove", agentId: "first" });
    expect(runtime.getModalTarget()).toBeNull();
    await press(0); expect(runtime.getModalTarget()).toBeNull();
    runtime.stop();
  });

  it("closes a moved agent's old modal and only opens the new workspace target", async () => {
    const { runtime, press, emit } = await harness();
    await press(0);
    emit({ kind: "upsert", agent: agent("first", "new-workspace") });
    expect(runtime.getModalTarget()).toBeNull();
    await press(0); expect(runtime.getModalTarget()).toBeNull();
    await press(2);
    expect(runtime.getModalTarget()).toEqual({ workspaceId: "new-workspace", agentId: "first" });
    runtime.stop();
  });

  it("notifies the mounted modal on disposal and never reopens from a stale callback", async () => {
    const { runtime, press } = await harness();
    await press(0); const states: unknown[] = [];
    runtime.subscribe(() => { states.push(runtime.getModalTarget()); });
    runtime.stop();
    expect(states).toContain(null);
    expect(runtime.getModalTarget()).toBeNull();
    await press(0); expect(runtime.getModalTarget()).toBeNull();
  });
});
