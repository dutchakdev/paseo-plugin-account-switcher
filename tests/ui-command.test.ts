import { describe, expect, it, vi } from "vitest";
import { defaultCommands, resolveAccountArgument, runAccountCommand, type AccountCommandDependencies } from "../client/command";
import type { Account, AccountState } from "../shared/contracts";

const account = (id: string, label: string, provider: "claude" | "codex" = "codex", extra: Partial<Account> = {}): Account =>
  ({ id, provider, label, source: "managed", email: null, plan: null, authStatus: "ready", createdAt: "2026-10-27T00:00:00Z", ...extra });
const state = (accounts: Account[], defaults = { claude: null, codex: null } as AccountState["defaults"]): AccountState => ({
  accounts, bindings: [], defaults, fallback: { claude: true, codex: true }, integration: { enabled: true, error: null },
  providers: { claude: { available: true, integrated: true }, codex: { available: true, integrated: true } },
});
const accounts = [account("cli", "Current CLI · Codex", "codex", { source: "system" }), account("work", "Work"), account("workshop", "Workshop"), account("second", "Second"), account("claude", "Work", "claude")];

describe("/account arguments", () => {
  it("opens the switcher without an argument", () => {
    expect(resolveAccountArgument(state(accounts), "codex", "  ")).toEqual({ kind: "open" });
  });
  it("matches the provider's accounts by exact label first, ignoring case", () => {
    expect(resolveAccountArgument(state(accounts), "codex", "work")).toEqual({ kind: "account", account: accounts[1] });
  });
  it("accepts a prefix only when one account starts with it", () => {
    expect(resolveAccountArgument(state(accounts), "codex", "sec")).toEqual({ kind: "account", account: accounts[3] });
    expect(resolveAccountArgument(state(accounts), "codex", "wor"))
      .toEqual({ kind: "error", message: "“wor” matches several Codex accounts: Work, Workshop." });
    expect(resolveAccountArgument(state([accounts[2], account("worker", "Worker")]), "codex", "wor"))
      .toEqual({ kind: "error", message: "“wor” matches several Codex accounts: Workshop, Worker." });
  });
  it("names the provider's accounts when nothing matches", () => {
    expect(resolveAccountArgument(state(accounts), "codex", "home"))
      .toEqual({ kind: "error", message: "No Codex account is named “home”. Accounts: Current CLI · Codex, Work, Workshop, Second." });
  });
  it("resolves `default` to the provider's default account", () => {
    expect(resolveAccountArgument(state(accounts, { claude: null, codex: "second" }), "codex", "default")).toEqual({ kind: "account", account: accounts[3] });
    expect(resolveAccountArgument(state(accounts), "codex", "default"))
      .toEqual({ kind: "error", message: "No default Codex account is set. Choose one in Accounts." });
  });
  it("lets an account named Default win over the keyword", () => {
    const named = account("named-default", "Default");
    expect(resolveAccountArgument(state([...accounts, named], { claude: null, codex: "second" }), "codex", "default")).toEqual({ kind: "account", account: named });
  });
  it("refuses an account that is not signed in", () => {
    expect(resolveAccountArgument(state([account("w", "Waiting", "codex", { authStatus: "needs_auth" })]), "codex", "waiting"))
      .toEqual({ kind: "error", message: "“Waiting” needs sign-in. Check it in Accounts." });
  });
});

describe("Command Center defaults", () => {
  it("offers each signed-in account that is not already its provider's default", () => {
    const items = defaultCommands(state(accounts, { claude: null, codex: "second" }));
    expect(items.map((item) => item.title)).toEqual([
      "Make “Current CLI · Codex” the Codex default", "Make “Work” the Codex default", "Make “Workshop” the Codex default", "Make “Work” the Claude default",
    ]);
    expect(items[0]).toMatchObject({ id: "default-cli", provider: "codex", accountId: "cli" });
  });
});

describe("/account on an agent", () => {
  const idle = { provider: "codex", status: "idle", activeTurn: null, pendingPermissions: [] as unknown[], model: "gpt-6.1-sol" };
  function deps(agent: object = idle, models?: string[]) {
    const calls = { prepare: vi.fn(async () => ({})), apply: vi.fn(async () => ({})), openSwitcher: vi.fn() };
    const value: AccountCommandDependencies = {
      state: async () => ({ ...state(accounts), bindings: [{ agentId: "agent", provider: "codex", currentAccountId: "cli", pendingAccountId: null, status: "ready", error: null }] }),
      usage: async () => models ? [{ accountId: "second", provider: "codex", status: "ok", plan: null, windows: [], models, fetchedAt: null, checkedAt: "2026-10-27T00:00:00Z", nextRetryAt: null, error: null }] : [],
      agent: async () => agent as never, ...calls,
    };
    return { value, calls };
  }
  it("applies at once on an idle agent", async () => {
    const { value, calls } = deps();
    await expect(runAccountCommand("codex", "agent", "second", value)).resolves.toBe("applied");
    expect(calls.prepare).toHaveBeenCalledWith("second");
    expect(calls.apply).toHaveBeenCalledExactlyOnceWith("second");
  });
  it("leaves the selection pending in the switcher while the agent is busy", async () => {
    const { value, calls } = deps({ ...idle, status: "running" });
    await expect(runAccountCommand("codex", "agent", "second", value)).resolves.toBe("pending");
    expect(calls.apply).not.toHaveBeenCalled();
    expect(calls.openSwitcher).toHaveBeenCalledOnce();
  });
  it("shows the plan warning instead of applying when the target lacks the agent's model", async () => {
    const { value, calls } = deps(idle, ["gpt-6-luna"]);
    await expect(runAccountCommand("codex", "agent", "second", value)).resolves.toBe("pending");
    expect(calls.apply).not.toHaveBeenCalled();
    expect(calls.openSwitcher).toHaveBeenCalledOnce();
  });
  it("opens the switcher for no argument or the current account, and refuses unsupported agents", async () => {
    for (const args of ["", "current cli"]) {
      const { value, calls } = deps();
      await expect(runAccountCommand("codex", "agent", args, value)).resolves.toBe("opened");
      expect(calls.prepare).not.toHaveBeenCalled();
    }
    await expect(runAccountCommand(null, "agent", "work", deps().value)).rejects.toThrow(/Claude and Codex only/);
  });
});
