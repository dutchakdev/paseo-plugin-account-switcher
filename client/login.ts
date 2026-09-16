import type { Account, LoginSession, Provider } from "../shared/contracts";
import { errorMessage } from "./format";

export type LoginMode = "device" | "browser";
export type { LoginSession } from "../shared/contracts";

/** Keep creation as a completed step if starting authorization fails. */
export async function addAndStartLogin(input: { provider: Provider; label: string; mode: LoginMode }, dependencies: {
  add(input: { provider: Provider; label: string }): Promise<Account>;
  start(input: { accountId: string; mode?: LoginMode }): Promise<LoginSession>;
  onCreated(account: Account): void;
}): Promise<LoginSession> {
  const account = await dependencies.add({ provider: input.provider, label: input.label });
  dependencies.onCreated(account);
  try {
    return await dependencies.start({ accountId: account.id, ...(account.provider === "codex" ? { mode: input.mode } : {}) });
  } catch (error) {
    throw new Error(`Account “${account.label}” was added. Could not start sign-in: ${errorMessage(error)} Try signing in again from its card.`);
  }
}

/**
 * Second and later submits of the add form reuse the account created by the first one,
 * so failed authorization can be retried without creating a duplicate account.
 */
export async function addOrResumeLogin(input: { provider: Provider; label: string; mode: LoginMode; created: Account | null }, dependencies: {
  add(input: { provider: Provider; label: string }): Promise<Account>;
  start(input: { accountId: string; mode?: LoginMode }): Promise<LoginSession>;
  onCreated(account: Account): void;
}): Promise<LoginSession> {
  const { created, ...fresh } = input;
  if (!created) return addAndStartLogin(fresh, dependencies);
  return dependencies.start({ accountId: created.id, ...(created.provider === "codex" ? { mode: input.mode } : {}) });
}

export function accountAvailable(account: Account): boolean {
  return account.authStatus === "ready" && !account.login;
}

/** Only act on a live HTTPS link; transport errors must remain visible to the user. */
export async function performLoginLinkAction(session: LoginSession, action: (url: string) => Promise<void>): Promise<void> {
  if ((session.status !== "waiting" && session.status !== "verifying") || !session.authorizationUrl) {
    throw new Error("This sign-in link is no longer available. Start sign-in again.");
  }
  const url = new URL(session.authorizationUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("The sign-in link is invalid. Start sign-in again.");
  await action(session.authorizationUrl);
}
