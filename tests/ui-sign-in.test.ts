import { describe, expect, it, vi } from "vitest";
import type { LoginSession } from "../shared/contracts";
import { performLoginLinkAction } from "../client/login";

const session: LoginSession = {
  id: "session-1", accountId: "account-1", provider: "claude", mode: "browser", status: "waiting",
  authorizationUrl: "https://claude.ai/oauth/authorize?state=fixture&code_challenge=fixture",
  userCode: null, canSubmitCode: true, error: null, expiresAt: null,
};

describe("browser and clipboard sign-in actions", () => {
  it("passes the exact authorization URL to the selected client action", async () => {
    const action = vi.fn(async () => {});
    await performLoginLinkAction(session, action);
    expect(action).toHaveBeenCalledExactlyOnceWith(session.authorizationUrl);
  });

  it.each(["starting", "complete", "error"] as const)("does not reuse a link from a %s session", async status => {
    const action = vi.fn(async () => {});
    await expect(performLoginLinkAction({ ...session, status }, action)).rejects.toThrow("no longer available");
    expect(action).not.toHaveBeenCalled();
  });

  it.each(["javascript:alert(1)", "http://claude.ai/oauth/authorize", "https://name:password@claude.ai/oauth/authorize"])("refuses unsafe link %s", async authorizationUrl => {
    const action = vi.fn(async () => {});
    await expect(performLoginLinkAction({ ...session, authorizationUrl }, action)).rejects.toThrow("invalid");
    expect(action).not.toHaveBeenCalled();
  });

  it("does not report successful copying when the client denies clipboard access", async () => {
    const action = vi.fn(async () => { throw new Error("Clipboard access denied"); });
    await expect(performLoginLinkAction(session, action)).rejects.toThrow("Clipboard access denied");
    expect(action).toHaveBeenCalledOnce();
  });
});
