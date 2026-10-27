import { describe, expect, it } from "vitest";
import { profileEnv } from "../server/session-env";
import type { Registry } from "../server/store";

type Account = { id: string; provider: "claude" | "codex"; source: "managed" | "system"; home: string };
type Binding = { agentId: string; provider: "claude" | "codex"; currentAccountId: string | null; launchAccountId: string | null };
const accounts: Account[] = [
  { id: "system-claude", provider: "claude", source: "system", home: "/home/me/.claude" },
  { id: "system-codex", provider: "codex", source: "system", home: "/home/me/.codex" },
  { id: "work-claude", provider: "claude", source: "managed", home: "/root/accounts/work-claude/claude" },
  { id: "other-claude", provider: "claude", source: "managed", home: "/root/accounts/other-claude/claude" },
  { id: "work-codex", provider: "codex", source: "managed", home: "/root/accounts/work-codex/codex" },
];
function registry(bindings: Binding[], integration: { enabled: boolean; providers: ("claude" | "codex")[] } = { enabled: true, providers: ["claude", "codex"] }) {
  return { accounts, bindings, integration: { ...integration, error: null } } as unknown as Registry;
}
const bind = (provider: "claude" | "codex", currentAccountId: string | null, launchAccountId: string | null = currentAccountId): Binding =>
  ({ agentId: "agent-1", provider, currentAccountId, launchAccountId });

describe("the profile a session's environment names", () => {
  it.each([
    ["a managed Claude account", "claude", bind("claude", "work-claude"), { CLAUDE_CONFIG_DIR: "/root/accounts/work-claude/claude" }],
    ["a managed Codex account", "codex", bind("codex", "work-codex"), { CODEX_HOME: "/root/accounts/work-codex/codex" }],
    ["an agent still launching, which has no current account yet", "claude", bind("claude", null, "work-claude"), { CLAUDE_CONFIG_DIR: "/root/accounts/work-claude/claude" }],
    ["the launch account when it differs from the current one", "claude", bind("claude", "work-claude", "other-claude"), { CLAUDE_CONFIG_DIR: "/root/accounts/other-claude/claude" }],
    ["the current account once there is no launch account", "claude", bind("claude", "work-claude", null), { CLAUDE_CONFIG_DIR: "/root/accounts/work-claude/claude" }],
  ])("names %s", (_, provider, binding, expected) => {
    expect(profileEnv(registry([binding]), "agent-1", provider)).toEqual(expected);
  });

  it.each([
    ["the system account, which is the CLI's own login", "claude", [bind("claude", "system-claude")]],
    ["an agent without a binding", "claude", []],
    ["another agent's binding", "claude", [{ ...bind("claude", "work-claude"), agentId: "agent-2" }]],
    ["a binding with no account at all", "claude", [bind("claude", null, null)]],
    ["an account the registry no longer has", "claude", [bind("claude", "gone")]],
    ["a provider that is neither claude nor codex", "opencode", [bind("claude", "work-claude")]],
    ["a binding made for the other provider", "codex", [bind("claude", "work-claude")]],
    ["an account of the other provider", "claude", [bind("claude", "work-codex")]],
  ])("names nothing for %s", (_, provider, bindings) => {
    expect(profileEnv(registry(bindings), "agent-1", provider)).toEqual({});
  });

  it("names nothing while integration is disabled, because the launcher is not in the chain", () => {
    expect(profileEnv(registry([bind("claude", "work-claude")], { enabled: false, providers: ["claude", "codex"] }), "agent-1", "claude")).toEqual({});
  });
  it("names nothing for a provider the integration does not own", () => {
    const bindings = [bind("claude", "work-claude"), { ...bind("codex", "work-codex"), agentId: "agent-2" }];
    const owned = registry(bindings, { enabled: true, providers: ["codex"] });
    expect(profileEnv(owned, "agent-1", "claude")).toEqual({});
    expect(profileEnv(owned, "agent-2", "codex")).toEqual({ CODEX_HOME: "/root/accounts/work-codex/codex" });
  });
});
