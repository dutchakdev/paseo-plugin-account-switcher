import type { Registry } from "./store";

/**
 * The login directory Paseo's own usage sources read for this agent: Claude from `CLAUDE_CONFIG_DIR`,
 * Codex from `CODEX_HOME`, Cursor from `XDG_CONFIG_HOME` on Linux. These hints let Paseo
 * read the selected profile; the launcher independently selects the CLI's credentials.
 *
 * Only a managed account has a directory of its own. The system account is the CLI's own login,
 * which Paseo already reads by default, so it adds nothing.
 */
export function profileEnv(registry: Registry, agentId: string, provider: string): Record<string, string> {
  if (provider !== "claude" && provider !== "codex" && provider !== "cursor") return {};
  // Without the launcher in the chain the CLI runs on the system login, whatever the binding says.
  if (!registry.integration.enabled || !registry.integration.providers.includes(provider)) return {};
  const binding = registry.bindings.find(candidate => candidate.agentId === agentId && candidate.provider === provider);
  // The same choice the launcher makes: the account an agent is launching on wins over the one it ran on.
  const accountId = binding?.launchAccountId ?? binding?.currentAccountId;
  const account = accountId ? registry.accounts.find(candidate => candidate.id === accountId && candidate.provider === provider) : undefined;
  if (account?.source !== "managed") return {};
  return provider === "claude" ? { CLAUDE_CONFIG_DIR: account.home } : provider === "cursor" ? process.platform === "darwin" ? { AGENT_CLI_CREDENTIAL_STORE: "memory" } : { XDG_CONFIG_HOME: account.home } : { CODEX_HOME: account.home };
}
