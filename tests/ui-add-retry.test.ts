import { describe, expect, it, vi } from "vitest";
import type { Account, LoginSession } from "../shared/contracts";
import { addOrResumeLogin } from "../client/login";
import { targetSlop, TOUCH_TARGET } from "../client/format";

const account: Account = {
  id: "created-account", provider: "codex", source: "managed", label: "Team", email: null, plan: null,
  authStatus: "needs_auth", createdAt: "2026-09-16T00:00:00Z", login: null,
};
const session: LoginSession = { id: "login-session", accountId: account.id, provider: "codex", mode: "device", status: "waiting", authorizationUrl: "https://auth.openai.com/codex/device", userCode: "EXAMPLE-CODE", canSubmitCode: false, error: null, expiresAt: null };

describe("add form keeps a failed login retryable", () => {
  it("surfaces the start failure after creation and retries without a duplicate account", async () => {
    let created: Account | null = null;
    const add = vi.fn(async () => account);
    const start = vi.fn<(input: { accountId: string; mode?: "device" | "browser" }) => Promise<typeof session>>()
      .mockRejectedValueOnce(new Error("Authorization unavailable")).mockResolvedValueOnce(session);
    const onCreated = vi.fn((value: Account) => { created = value; });
    await expect(addOrResumeLogin({ provider: "codex", label: "Team", mode: "device", created }, { add, start, onCreated }))
      .rejects.toThrow("Account “Team” was added. Could not start sign-in: Authorization unavailable");
    expect(created).toEqual(account);
    await expect(addOrResumeLogin({ provider: "codex", label: "", mode: "browser", created }, { add, start, onCreated })).resolves.toEqual(session);
    expect(add).toHaveBeenCalledOnce();
    expect(start).toHaveBeenLastCalledWith({ accountId: account.id, mode: "browser" });
    expect(onCreated).toHaveBeenCalledOnce();
  });
  it("retries a Claude account without a Codex login mode", async () => {
    const start = vi.fn(async () => session);
    await addOrResumeLogin({ provider: "claude", label: "", mode: "device", created: { ...account, provider: "claude" } }, { add: vi.fn(), start, onCreated: vi.fn() });
    expect(start).toHaveBeenCalledWith({ accountId: account.id });
  });
});

describe("touch targets", () => {
  it("pads every drawn box up to the 44px target", () => {
    for (const box of [24, 28, 36, 44]) {
      const slop = targetSlop(box);
      expect(box + slop.top + slop.bottom).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(slop.top).toBe(slop.bottom);
    }
    expect(targetSlop(44)).toEqual({ top: 0, bottom: 0, left: 4, right: 4 });
  });
});
