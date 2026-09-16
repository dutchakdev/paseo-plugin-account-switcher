import { describe, expect, it, vi } from "vitest";
import type { Account, LoginSession } from "../shared/contracts";
import { accountAvailable, addAndStartLogin } from "../client/login";

const account: Account = {
  id: "created-account", provider: "codex", source: "managed", label: "Team", email: null, plan: null,
  authStatus: "needs_auth", createdAt: "2026-09-15T20:00:00Z", login: null,
};
const session: LoginSession = { id: "login-session", accountId: account.id, provider: "codex", mode: "device", status: "waiting", authorizationUrl: "https://auth.openai.com/codex/device", userCode: "EXAMPLE-CODE", canSubmitCode: false, error: null, expiresAt: null };

describe("add and sign in from Paseo", () => {
  it("opens the selected Codex login mode for the account returned by creation", async () => {
    const events: string[] = [];
    const add = vi.fn(async () => { events.push("created"); return account; });
    const start = vi.fn(async () => { events.push("login"); return session; });
    const onCreated = vi.fn(() => { events.push("creation-confirmed"); });
    await expect(addAndStartLogin({ provider: "codex", label: "Team", mode: "browser" }, { add, start, onCreated })).resolves.toEqual(session);
    expect(start).toHaveBeenCalledWith({ accountId: "created-account", mode: "browser" });
    expect(events).toEqual(["created", "creation-confirmed", "login"]);
  });

  it("keeps the successful creation visible when starting authorization fails", async () => {
    const created: Account[] = [];
    const add = vi.fn(async () => { created.push(account); return account; });
    const onCreated = vi.fn();
    const start = vi.fn(async () => { throw new Error("Authorization unavailable"); });
    await expect(addAndStartLogin({ provider: "codex", label: "Team", mode: "device" }, { add, start, onCreated }))
      .rejects.toThrow("Account “Team” was added. Could not start sign-in: Authorization unavailable Try signing in again from its card.");
    expect(created).toEqual([account]);
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(account);
    expect(add).toHaveBeenCalledOnce();
  });

  it("does not try login when account creation fails", async () => {
    const start = vi.fn(), onCreated = vi.fn();
    await expect(addAndStartLogin({ provider: "codex", label: "Team", mode: "device" }, {
      add: async () => { throw new Error("Registry unavailable"); }, start, onCreated,
    })).rejects.toThrow("Registry unavailable");
    expect(start).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("uses Claude's official flow without a Codex login-mode override", async () => {
    const start = vi.fn(async () => session);
    await addAndStartLogin({ provider: "claude", label: "Team", mode: "browser" }, {
      add: async () => ({ ...account, provider: "claude" }), start, onCreated: () => {},
    });
    expect(start).toHaveBeenCalledWith({ accountId: account.id });
  });

  it("prevents an older ready status from enabling a profile whose saved login is still open", () => {
    expect(accountAvailable({ ...account, authStatus: "ready", login: { sessionId: session.id, mode: session.mode } })).toBe(false);
    expect(accountAvailable({ ...account, authStatus: "ready", login: null })).toBe(true);
    expect(accountAvailable({ ...account, authStatus: "needs_auth", login: null })).toBe(false);
  });
});
