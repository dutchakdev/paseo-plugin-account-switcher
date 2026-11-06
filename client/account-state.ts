import type { Account, AccountState } from "../shared/contracts";
import type { Tone } from "./format";

/** A negative CLI probe is not evidence that a browser sign-in is still open. */
export function signInFeedback(account: Account): { text: string; tone: Tone } {
  if (account.authStatus === "ready") return { text: "Sign-in confirmed.", tone: "success" };
  if (account.authStatus === "error") return { text: account.provider === "claude"
    ? "Cannot check sign-in. Check credential access and, on macOS, unlock Keychain and allow Claude Code access. Then try again."
    : "Cannot check sign-in. Check this host’s Codex credentials, then try again.", tone: "warning" };
  if (account.authStatus === "unknown") return { text: "Sign-in could not be confirmed. Check this host’s CLI configuration, then try again.", tone: "warning" };
  return { text: account.source === "system"
    ? `Sign in with ${account.provider === "claude" ? "claude auth login" : "codex login"} on this host, then check again.`
    : "Sign in to this account to use it in agents.", tone: "warning" };
}

export function accountRemovalBlockers(account: Account, state: AccountState): string[] {
  const blockers: string[] = [];
  if (account.source === "system") blockers.push("This is the host’s CLI sign-in. Manage it in the CLI; it cannot be removed here.");
  if (account.login) blockers.push("Finish or cancel sign-in first.");
  if (state.defaults[account.provider] === account.id) blockers.push("Clear this account’s default first.");
  if (state.bindings.some(binding => binding.currentAccountId === account.id || binding.pendingAccountId === account.id)) {
    blockers.push("Switch agents to another account and clear pending selections first. Include archived agents you may resume.");
  }
  return blockers;
}
