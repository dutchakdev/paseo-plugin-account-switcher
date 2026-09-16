import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Account, LoginSession } from "../shared/contracts";

export type SignInTarget = { account: Account; hostId: string; sessionId: string; initial?: LoginSession; autoOpen: boolean };

export function visibleSignInTarget(target: SignInTarget | null, hostId: string): SignInTarget | null {
  return target?.hostId === hostId ? target : null;
}

/** A late cancellation or dismissal belongs to this opening, not a later one. */
export function closeSignInTarget(current: SignInTarget | null, expected: SignInTarget, hostId: string): SignInTarget | null {
  return current === expected && expected.hostId === hostId ? null : current;
}

export function signInQueryKey(target: SignInTarget) {
  return ["account-switcher", target.hostId, "login", target.account.id, target.sessionId] as const;
}

export function signInPollInterval(status: LoginSession["status"] | undefined, error: unknown, actionPending: boolean): number | false {
  if (actionPending || status === "complete" || status === "error") return false;
  return error ? 5_000 : status === "starting" ? 1_000 : 2_000;
}

/** A failed process may still hold its account reservation until cancellation succeeds. */
export function canCancelSignIn(status: LoginSession["status"] | undefined, account: Account | undefined, sessionId: string): boolean {
  if (status === "complete") return false;
  if (status !== "error") return true;
  return Boolean(account?.login && "sessionId" in account.login && account.login.sessionId === sessionId);
}

export function signInQueryOptions(target: SignInTarget, read: (input: { accountId: string; sessionId: string }) => Promise<LoginSession>, actionPending: boolean) {
  return queryOptions({
    queryKey: signInQueryKey(target),
    queryFn: () => read({ accountId: target.account.id, sessionId: target.sessionId }),
    initialData: target.initial, retry: 1, refetchOnWindowFocus: false, refetchOnReconnect: false,
    refetchInterval: query => signInPollInterval(query.state.data?.status, query.state.error, actionPending),
    gcTime: 0,
  });
}

/** Cancel the old poll before submitting, so its delayed reply cannot regress the result. */
export async function submitSignInCode(cache: QueryClient, target: SignInTarget, submit: () => Promise<LoginSession>): Promise<LoginSession> {
  const queryKey = signInQueryKey(target);
  await cache.cancelQueries({ queryKey, exact: true });
  const result = await submit();
  cache.setQueryData(queryKey, result);
  return result;
}
