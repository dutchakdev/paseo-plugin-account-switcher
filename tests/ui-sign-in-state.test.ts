import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { Account, LoginSession } from "../shared/contracts";
import { canCancelSignIn, closeSignInTarget, signInPollInterval, signInQueryKey, signInQueryOptions, submitSignInCode, visibleSignInTarget, type SignInTarget } from "../client/sign-in-state";

const account: Account = { id: "account", provider: "claude", label: "Team", source: "managed", email: null, plan: null, authStatus: "needs_auth", createdAt: "2026-09-16" };
const waiting: LoginSession = { id: "session", accountId: account.id, provider: "claude", mode: "browser", status: "waiting", authorizationUrl: "https://claude.ai/oauth/authorize?state=fixture", userCode: null, canSubmitCode: true, error: null, expiresAt: null };
const target = (patch: Partial<SignInTarget> = {}): SignInTarget => ({ account, hostId: "host", sessionId: waiting.id, initial: waiting, autoOpen: false, ...patch });
const caches: QueryClient[] = [];
function queryClient() { const cache = new QueryClient(); caches.push(cache); return cache; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { for (const cache of caches.splice(0)) cache.clear(); });

describe("sign-in dialog ownership", () => {
  it("keeps a newly opened dialog when cancellation of the old session finishes late", async () => {
    const first = target();
    const second = target({ sessionId: "next-session" });
    let current: SignInTarget | null = first;
    const cancellation = deferred<void>();
    const cancelAndClose = cancellation.promise.then(() => { current = closeSignInTarget(current, first, "host"); });
    current = closeSignInTarget(current, first, "host");
    current = second;
    cancellation.resolve(); await cancelAndClose;
    expect(current).toBe(second);
    expect(closeSignInTarget(current, second, "host")).toBeNull();
  });

  it("distinguishes reopening the same session from its previous dialog instance", () => {
    const first = target(), reopened = target();
    expect(reopened).toEqual(first);
    expect(closeSignInTarget(reopened, first, "host")).toBe(reopened);
    expect(closeSignInTarget(reopened, reopened, "host")).toBeNull();
  });

  it("hides targets from another host and prevents that host from dismissing them", () => {
    const first = target();
    expect(visibleSignInTarget(first, "other-host")).toBeNull();
    expect(closeSignInTarget(first, first, "other-host")).toBe(first);
    expect(visibleSignInTarget(first, "host")).toBe(first);
  });
});

describe("sign-in status recovery", () => {
  it("retries a transient transport failure and restores live status without reopening the dialog", async () => {
    const cache = queryClient(), current = target();
    const read = vi.fn<(input: { accountId: string; sessionId: string }) => Promise<LoginSession>>()
      .mockRejectedValueOnce(new Error("Temporary disconnect")).mockResolvedValueOnce(waiting);
    const result = await cache.fetchQuery({ ...signInQueryOptions(current, read, false), retryDelay: 0 });
    expect(result).toEqual(waiting);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith({ accountId: account.id, sessionId: waiting.id });
    expect(cache.getQueryState(signInQueryKey(current))?.error).toBeNull();
  });

  it("keeps a recovery interval after retries fail and resumes the normal interval after a successful retry", async () => {
    const cache = queryClient(), current = target();
    const read = vi.fn<() => Promise<LoginSession>>()
      .mockRejectedValueOnce(new Error("Disconnected")).mockRejectedValueOnce(new Error("Still disconnected"))
      .mockResolvedValueOnce(waiting);
    const options = { ...signInQueryOptions(current, read, false), retryDelay: 0 };
    await expect(cache.fetchQuery(options)).rejects.toThrow("Still disconnected");
    const failed = cache.getQueryState<LoginSession>(signInQueryKey(current))!;
    expect(failed.data?.status).toBe("waiting");
    expect(signInPollInterval(failed.data?.status, failed.error, false)).toBe(5_000);
    await cache.fetchQuery(options);
    const recovered = cache.getQueryState<LoginSession>(signInQueryKey(current))!;
    expect(signInPollInterval(recovered.data?.status, recovered.error, false)).toBe(2_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("pauses polling during actions and after terminal states while keeping active sessions refreshable", () => {
    expect(signInPollInterval("starting", null, false)).toBe(1_000);
    expect(signInPollInterval("waiting", null, false)).toBe(2_000);
    expect(signInPollInterval("verifying", null, false)).toBe(2_000);
    for (const status of ["starting", "waiting", "verifying"] as const) expect(signInPollInterval(status, new Error("Transport"), true)).toBe(false);
    for (const status of ["complete", "error"] as const) expect(signInPollInterval(status, new Error("Transport"), false)).toBe(false);
  });
});

describe("authorization code submission", () => {
  it("cancels an older status poll before submission and ignores its delayed waiting response", async () => {
    const cache = queryClient(), current = target(), key = signInQueryKey(current);
    const oldResponse = deferred<LoginSession>();
    cache.setQueryData(key, waiting);
    const oldPoll = cache.fetchQuery({ queryKey: key, queryFn: () => oldResponse.promise }).catch(error => error);
    expect(cache.getQueryState(key)?.fetchStatus).toBe("fetching");
    const verifying: LoginSession = { ...waiting, status: "verifying", canSubmitCode: false };
    await submitSignInCode(cache, current, async () => {
      expect(cache.getQueryState(key)?.fetchStatus).toBe("idle");
      return verifying;
    });
    oldResponse.resolve(waiting);
    await oldResponse.promise; await oldPoll;
    expect(cache.getQueryData(key)).toEqual(verifying);
  });

  it("leaves polls for other hosts, sessions and exact-key descendants running", async () => {
    const cache = queryClient(), current = target(), key = signInQueryKey(current);
    const otherKeys = [signInQueryKey(target({ hostId: "other-host" })), signInQueryKey(target({ sessionId: "other-session" })), [...key, "details"]];
    const responses = otherKeys.map(() => deferred<LoginSession>());
    const polls = otherKeys.map((queryKey, index) => cache.fetchQuery({ queryKey, queryFn: () => responses[index].promise }));
    await submitSignInCode(cache, current, async () => ({ ...waiting, status: "complete" }));
    for (const otherKey of otherKeys) expect(cache.getQueryState(otherKey)?.fetchStatus).toBe("fetching");
    for (const response of responses) response.resolve(waiting);
    await Promise.all(polls);
    expect(cache.getQueryData<LoginSession>(key)?.status).toBe("complete");
    for (const otherKey of otherKeys) expect(cache.getQueryData<LoginSession>(otherKey)?.status).toBe("waiting");
  });

  it("surfaces a rejected submission without inventing a successful session status", async () => {
    const cache = queryClient(), current = target(), key = signInQueryKey(current);
    cache.setQueryData(key, waiting);
    await expect(submitSignInCode(cache, current, async () => { throw new Error("Authorization code rejected"); })).rejects.toThrow("Authorization code rejected");
    expect(cache.getQueryData(key)).toEqual(waiting);
  });
});

describe("cancellation after a process error", () => {
  it("keeps cancellation available while the failed session still reserves the account", () => {
    const reserved: Account = { ...account, login: { sessionId: waiting.id, mode: "browser" } };
    expect(canCancelSignIn("error", reserved, waiting.id)).toBe(true);
    expect(canCancelSignIn("error", { ...reserved, login: null }, waiting.id)).toBe(false);
  });

  it("does not offer to cancel a replacement session using an older dialog", () => {
    const replaced: Account = { ...account, login: { sessionId: "new-session", mode: "browser" } };
    expect(canCancelSignIn("error", replaced, waiting.id)).toBe(false);
    expect(canCancelSignIn("error", replaced, "new-session")).toBe(true);
  });

  it("requires observed reservation for failed sessions but keeps active sessions cancellable during a metadata outage", () => {
    expect(canCancelSignIn("error", undefined, waiting.id)).toBe(false);
    expect(canCancelSignIn("error", { ...account, login: { workspaceId: "old-workspace", terminalId: "old-terminal" } }, waiting.id)).toBe(false);
    for (const status of [undefined, "starting", "waiting", "verifying"] as const) expect(canCancelSignIn(status, undefined, waiting.id)).toBe(true);
    expect(canCancelSignIn("complete", { ...account, login: { sessionId: waiting.id, mode: "browser" } }, waiting.id)).toBe(false);
  });
});
