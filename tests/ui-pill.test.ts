import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaseoAgent } from "@getpaseo/client";
import type { PluginClientContext, PluginComposerPillContribution } from "@getpaseo/plugin/client";
import type { AccountState } from "../shared/contracts";
import { createClientRuntime } from "../client/runtime";

async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const agent = { id: "agent-1", workspaceId: "workspace-1", provider: "codex", status: "idle", archivedAt: null } as PaseoAgent;
const state: AccountState = {
  accounts: [{ id: "system-codex", provider: "codex", source: "system", label: "System", authStatus: "ready", email: null, plan: null, createdAt: "2026-09-16" }],
  bindings: [], defaults: { claude: null, codex: null }, integration: { enabled: true, error: null },
};

afterEach(() => vi.useRealTimers());

describe("composer account modal", () => {
  it("opens the pressed agent's modal through a stable custom icon without opening a panel", async () => {
    vi.useFakeTimers();
    const update = vi.fn();
    const add = vi.fn((_contribution: PluginComposerPillContribution) => ({ update, remove: vi.fn() }));
    const context = {
      paseo: { agents: { subscribe: vi.fn(() => vi.fn()), list: vi.fn(async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } })) } },
      rpc: vi.fn(async (contract: { name: string }) => contract.name === "accounts.list" ? state : { accounts: [] }),
      addComposerPill: add,
      openPanel: vi.fn(),
    } as unknown as PluginClientContext;
    const AccountIcon = () => null;
    const runtime = createClientRuntime(context, AccountIcon);
    await flush();
    const button = add.mock.lastCall?.[0].button;
    expect(button?.behavior.kind).toBe("action");
    expect(button?.icon).toBe(AccountIcon);
    expect(runtime.getModalTarget()).toBeNull();
    expect(update.mock.lastCall?.[0].label ?? button?.label).toContain("System");
    if (button?.behavior.kind === "action") await button.behavior.onPress();
    expect(runtime.getModalTarget()).toEqual({ workspaceId: "workspace-1", agentId: "agent-1" });
    expect(context.openPanel).not.toHaveBeenCalled();
    runtime.refresh(); await flush();
    expect(add).toHaveBeenCalledOnce();
    expect(update.mock.lastCall?.[0]).not.toHaveProperty("icon");
    runtime.stop();
  });
});
