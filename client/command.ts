import type { Account, AccountState, Provider, UsageSnapshot } from "../shared/contracts";
import { agentModel, currentAccount, idleForSwitch, switchRisk } from "./format";
import { accountAvailable } from "./login";

export type AccountArgument = { kind: "open" } | { kind: "account"; account: Account } | { kind: "error"; message: string };

const shortName: Record<Provider, string> = { claude: "Claude", codex: "Codex" };

/** What `/account <args>` refers to among the agent's provider accounts. Never guesses between several matches. */
export function resolveAccountArgument(state: AccountState, provider: Provider, args: string): AccountArgument {
  const query = args.trim();
  if (!query) return { kind: "open" };
  const accounts = state.accounts.filter((account) => account.provider === provider);
  let account: Account | undefined;
  // An account that is literally named "Default" wins over the keyword.
  if (query.toLowerCase() === "default" && !accounts.some((item) => item.label.toLowerCase() === "default")) {
    account = accounts.find((item) => item.id === state.defaults[provider]);
    if (!account) return { kind: "error", message: `No default ${shortName[provider]} account is set. Choose one in Accounts.` };
  } else {
    const wanted = query.toLowerCase();
    const exact = accounts.filter((item) => item.label.toLowerCase() === wanted);
    const matches = exact.length ? exact : accounts.filter((item) => item.label.toLowerCase().startsWith(wanted));
    if (matches.length > 1) return { kind: "error", message: `“${query}” matches several ${shortName[provider]} accounts: ${matches.map((item) => item.label).join(", ")}.` };
    if (!matches.length) return { kind: "error", message: `No ${shortName[provider]} account is named “${query}”. Accounts: ${accounts.map((item) => item.label).join(", ")}.` };
    account = matches[0];
  }
  if (!accountAvailable(account)) return { kind: "error", message: `“${account.label}” ${account.login ? "is still signing in" : "needs sign-in"}. Check it in Accounts.` };
  return { kind: "account", account };
}

export type DefaultCommand = { id: string; title: string; provider: Provider; accountId: string };

/** Command Center entries that make a signed-in account its provider's default. */
export function defaultCommands(state: AccountState): DefaultCommand[] {
  return (["codex", "claude"] as const).flatMap((provider) => state.accounts
    .filter((account) => account.provider === provider && accountAvailable(account) && state.defaults[provider] !== account.id)
    .map((account) => ({ id: `default-${account.id}`, title: `Make “${account.label}” the ${shortName[provider]} default`, provider, accountId: account.id })));
}

export type AccountCommandDependencies = {
  state(): Promise<AccountState>;
  usage(): Promise<UsageSnapshot[]>;
  /** The agent's latest snapshot; null when it no longer exists. */
  agent(): Promise<Parameters<typeof idleForSwitch>[0] & Parameters<typeof agentModel>[0]>;
  prepare(accountId: string): Promise<unknown>;
  apply(accountId: string): Promise<unknown>;
  openSwitcher(): void;
};

/** `/account [name | default]`: applies at once when the agent is idle and nothing warns against it; otherwise leaves the
 * selection pending in the switcher, where Apply and any warning are visible. Throws messages for the host's error toast. */
export async function runAccountCommand(provider: Provider | null, agentId: string, args: string, deps: AccountCommandDependencies): Promise<"opened" | "applied" | "pending"> {
  if (!provider) throw new Error("Account switching is available for Claude and Codex only.");
  const state = await deps.state();
  const target = resolveAccountArgument(state, provider, args);
  if (target.kind === "error") throw new Error(target.message);
  if (target.kind === "open" || currentAccount(state, agentId, provider)?.id === target.account.id) { deps.openSwitcher(); return "opened"; }
  await deps.prepare(target.account.id);
  const [agent, usage] = await Promise.all([deps.agent(), deps.usage().catch(() => [])]);
  const risk = switchRisk({ label: target.account.label, models: usage.find((item) => item.accountId === target.account.id)?.models }, agentModel(agent));
  if (risk || !idleForSwitch(agent)) { deps.openSwitcher(); return "pending"; }
  await deps.apply(target.account.id);
  return "applied";
}
