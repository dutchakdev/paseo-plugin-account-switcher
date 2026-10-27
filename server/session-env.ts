import type { Registry } from "./store";

/**
 * The login directory Paseo's own usage sources read for this agent: Claude from `CLAUDE_CONFIG_DIR`,
 * Codex from `CODEX_HOME`. The launcher sets the same variable for the CLI it starts, so naming it
 * here changes what Paseo looks at and not what the CLI runs on.
 *
 * Only a managed account has a directory of its own. The system account is the CLI's own login,
 * which Paseo already reads by default, so it adds nothing.
 */
export function profileEnv(registry: Registry, agentId: string, provider: string): Record<string, string> {
  if (provider !== "claude" && provider !== "codex") return {};
  // Without the launcher in the chain the CLI runs on the system login, whatever the binding says.
  if (!registry.integration.enabled || !registry.integration.providers.includes(provider)) return {};
  const binding = registry.bindings.find(candidate => candidate.agentId === agentId && candidate.provider === provider);
  // The same choice the launcher makes: the account an agent is launching on wins over the one it ran on.
  const accountId = binding?.launchAccountId ?? binding?.currentAccountId;
  const account = accountId ? registry.accounts.find(candidate => candidate.id === accountId && candidate.provider === provider) : undefined;
  if (account?.source !== "managed") return {};
  return provider === "claude" ? { CLAUDE_CONFIG_DIR: account.home } : { CODEX_HOME: account.home };
}
