import { describe, expect, it } from "vitest";
import { accountRemovalBlockers, signInFeedback } from "../client/account-state";
import type { Account, AccountState } from "../shared/contracts";

const account: Account = { id: "account", provider: "claude", source: "managed", label: "Work", email: null, plan: null, authStatus: "ready", createdAt: "2026-11-06", login: null };
const state = { defaults: { claude: null, codex: null }, bindings: [] } as unknown as AccountState;

describe("account recovery guidance", () => {
  it("asks to restore credential access rather than finish an unstarted browser sign-in", () => {
    const feedback = signInFeedback({ ...account, source: "system", authStatus: "error" });
    expect(feedback.text).toContain("Keychain");
    expect(feedback.text).not.toContain("browser");
    expect(feedback.tone).toBe("warning");
  });
  it("uses the CLI's own login command for a genuinely signed-out system account", () => {
    expect(signInFeedback({ ...account, source: "system", authStatus: "needs_auth" }).text).toContain("claude auth login");
    expect(signInFeedback({ ...account, provider: "codex", source: "system", authStatus: "needs_auth" }).text).toContain("codex login");
    expect(signInFeedback({ ...account, provider: "codex", authStatus: "error" }).text).not.toContain("Claude");
  });
});

describe("removal confirmation", () => {
  it("allows an unused managed account to be removed", () => {
    expect(accountRemovalBlockers(account, state)).toEqual([]);
  });
  it("explains every prerequisite before enabling removal, including the default", () => {
    const busy = { ...state, defaults: { ...state.defaults, claude: account.id }, bindings: [{ currentAccountId: account.id, pendingAccountId: null }] } as AccountState;
    const blockers = accountRemovalBlockers({ ...account, login: { sessionId: "login", mode: "browser" } }, busy);
    expect(blockers).toHaveLength(3);
    expect(blockers.join(" ")).toContain("default");
    expect(blockers.join(" ")).toContain("archived");
    expect(accountRemovalBlockers(account, { ...state, bindings: [{ currentAccountId: "other", pendingAccountId: account.id }] } as AccountState)).toHaveLength(1);
  });
  it("keeps the host CLI account outside plugin-owned deletion", () => {
    expect(accountRemovalBlockers({ ...account, source: "system" }, state).join(" ")).toContain("cannot be removed here");
  });
});
