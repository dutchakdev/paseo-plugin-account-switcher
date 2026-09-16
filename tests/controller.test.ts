import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";

const mocks = vi.hoisted(() => ({
  launchLogin: vi.fn(), probeAccount: vi.fn(), removeAccountCredentials: vi.fn(),
  prepareRuntime: vi.fn(), reconcileIntegration: vi.fn(),
  failRemovePath: undefined as string | undefined,
  usage: {
    start: vi.fn(), close: vi.fn(), invalidate: vi.fn(), refresh: vi.fn(), list: vi.fn(),
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (path: PathLike, options: Parameters<typeof actual.rm>[1]) => {
      if (String(path) === mocks.failRemovePath) throw Object.assign(new Error("Profile cleanup denied"), { code: "EACCES" });
      return actual.rm(path, options);
    },
  };
});

vi.mock("../server/auth", () => ({
  launchLogin: mocks.launchLogin, probeAccount: mocks.probeAccount, removeAccountCredentials: mocks.removeAccountCredentials,
  accountCommand: () => ["fixture-cli"], accountEnvironment: () => ({}),
}));
vi.mock("../server/integration", () => ({
  writeLaunchers: async () => {}, prepareRuntime: mocks.prepareRuntime, reconcileIntegration: mocks.reconcileIntegration,
  installIntegration: async () => {}, restoreIntegration: async () => {},
}));
vi.mock("../server/profiles", () => ({ prepareProfile: async () => {} }));
vi.mock("../server/usage", () => ({ createUsageService: () => mocks.usage, readCredentialVersion: async () => "fixture-version" }));

import { AccountController } from "../server/controller";
import { AccountStore, accountFrom } from "../server/store";

const roots: string[] = [];
const controllers: AccountController[] = [];
const paseo = {
  agents: { ref: () => ({ refresh: async () => ({ agent: { provider: "codex", status: "idle", activeTurn: null, pendingPermissions: [], archivedAt: null } }) }) },
} as unknown as PaseoApi;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.failRemovePath = undefined;
  mocks.launchLogin.mockReset().mockResolvedValue({ workspaceId: "login-workspace", terminalId: "login-terminal" });
  mocks.probeAccount.mockReset().mockResolvedValue({ identityKey: "fixture-account", email: "account@example.test", plan: "plus", authStatus: "ready" });
  mocks.removeAccountCredentials.mockReset().mockResolvedValue(undefined);
  mocks.prepareRuntime.mockReset().mockResolvedValue(undefined);
  mocks.reconcileIntegration.mockReset().mockResolvedValue(undefined);
  mocks.usage.close.mockResolvedValue(undefined);
  mocks.usage.refresh.mockResolvedValue([]);
  mocks.usage.list.mockResolvedValue([]);
});

afterEach(async () => {
  mocks.failRemovePath = undefined;
  await Promise.all(controllers.splice(0).map(controller => controller.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function newRoot() {
  const root = await mkdtemp(join(tmpdir(), "account-controller-test-"));
  roots.push(root);
  return root;
}

async function start(root?: string) {
  const controller = new AccountController(root ?? await newRoot());
  controllers.push(controller);
  await controller.ready;
  return controller;
}

async function fixture() {
  const controller = await start();
  const account = await controller.store.add("codex", "Managed");
  await mkdir(account.home, { recursive: true });
  return { controller, account };
}

async function loginReceipt(root: string, id: string, loginToken: string, exitCode = 0) {
  await mkdir(join(root, "logins"), { recursive: true });
  await writeFile(join(root, "logins", `${id}.json`), JSON.stringify({ loginToken, exitCode }));
}

describe("persistent login isolation", () => {
  it("admits one login when two clients request the same account concurrently", async () => {
    const { controller, account } = await fixture();
    const attempts = await Promise.allSettled([controller.login(paseo, account.id), controller.login(paseo, account.id)]);
    expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(attempt => attempt.status === "rejected")).toHaveLength(1);
    expect(mocks.launchLogin).toHaveBeenCalledOnce();
    expect(accountFrom(await controller.store.read(), account.id).loginToken).toEqual(expect.any(String));
  });

  it("keeps an unfinished login reserved after restart and blocks probes, deletion, apply and default launches", async () => {
    const { controller, account } = await fixture();
    await controller.login(paseo, account.id);
    const token = accountFrom(await controller.store.read(), account.id).loginToken;
    await controller.close();
    const restarted = await start(controller.store.root);
    expect(accountFrom(await restarted.store.read(), account.id).loginToken).toBe(token);
    await expect(restarted.login(paseo, account.id)).rejects.toThrow(/Sign-in is already open/);
    await expect(restarted.checkAccount(account.id)).rejects.toThrow(/Finish signing in/);
    await expect(restarted.remove(account.id)).rejects.toThrow(/Finish signing in/);
    await restarted.store.change(registry => { registry.integration.enabled = true; registry.defaults.codex = account.id; });
    const switcher = restarted.switcher(paseo);
    await switcher.prepare("agent-one", account.id);
    await expect(switcher.apply("agent-one")).rejects.toThrow(/Finish signing in/);
    await expect(switcher.bindNewAgent("agent-two", "codex")).rejects.toThrow(/Default account sign-in/);
    expect((await restarted.store.read()).bindings.some(binding => binding.agentId === "agent-two")).toBe(false);
    expect(mocks.probeAccount).not.toHaveBeenCalled();
    expect(mocks.removeAccountCredentials).not.toHaveBeenCalled();
    expect(mocks.launchLogin).toHaveBeenCalledOnce();
  });

  it("keeps the lock for a missing or stale completion receipt, then unlocks only the matching login", async () => {
    const { controller, account } = await fixture();
    await controller.login(paseo, account.id);
    const token = accountFrom(await controller.store.read(), account.id).loginToken!;
    await expect(controller.finishLogin(account.id)).rejects.toThrow(/has not finished yet/);
    await loginReceipt(controller.store.root, account.id, "an-earlier-login");
    await expect(controller.finishLogin(account.id)).rejects.toThrow(/has not finished yet/);
    expect(accountFrom(await controller.store.read(), account.id).loginToken).toBe(token);
    expect(mocks.probeAccount).not.toHaveBeenCalled();
    await loginReceipt(controller.store.root, account.id, token);
    const completed = await controller.finishLogin(account.id);
    expect(completed).toMatchObject({ id: account.id, authStatus: "ready", email: "account@example.test" });
    expect(completed).not.toHaveProperty("loginToken");
    expect(completed).not.toHaveProperty("identityKey");
    expect(accountFrom(await controller.store.read(), account.id).loginToken).toBeNull();
    expect(mocks.probeAccount).toHaveBeenCalledOnce();
  });

  it("quarantines accounts with an open login from quota collection", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(registry => { registry.commands = { claude: ["fixture-cli"], codex: ["fixture-cli"] }; });
    await controller.login(paseo, account.id);
    const listed = await controller.quotaAccounts();
    expect(listed.map(item => item.id)).toEqual(["system-claude", "system-codex"]);
    expect(mocks.probeAccount.mock.calls.map(([item]) => item.id)).not.toContain(account.id);
  });

  it("releases a reservation when opening the login terminal fails, so retry works", async () => {
    const { controller, account } = await fixture();
    mocks.launchLogin.mockRejectedValueOnce(new Error("Terminal unavailable"));
    await expect(controller.login(paseo, account.id)).rejects.toThrow("Terminal unavailable");
    expect(accountFrom(await controller.store.read(), account.id).loginToken).toBeNull();
    await expect(controller.login(paseo, account.id)).resolves.toMatchObject({ terminalId: "login-terminal" });
  });
});

describe("account deletion retry", () => {
  it("retains the registry and profile when credential cleanup fails", async () => {
    const { controller, account } = await fixture();
    mocks.removeAccountCredentials.mockRejectedValueOnce(new Error("Keychain unavailable"));
    await expect(controller.remove(account.id)).rejects.toThrow("Keychain unavailable");
    expect(accountFrom(await controller.store.read(), account.id).id).toBe(account.id);
    await expect(access(account.home)).resolves.toBeUndefined();
    expect(mocks.usage.invalidate).not.toHaveBeenCalled();
    await controller.remove(account.id);
    expect((await controller.store.read()).accounts.some(item => item.id === account.id)).toBe(false);
    await expect(access(account.home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a retryable registry record when profile removal fails after credential cleanup", async () => {
    const { controller, account } = await fixture();
    mocks.failRemovePath = dirname(account.home);
    await expect(controller.remove(account.id)).rejects.toThrow("Profile cleanup denied");
    expect(mocks.removeAccountCredentials).toHaveBeenCalledOnce();
    expect(accountFrom(await controller.store.read(), account.id).id).toBe(account.id);
    expect(mocks.usage.invalidate).not.toHaveBeenCalled();
    mocks.failRemovePath = undefined;
    await controller.remove(account.id);
    expect((await controller.store.snapshot()).accounts.some(item => item.id === account.id)).toBe(false);
    expect(mocks.usage.invalidate).toHaveBeenCalledWith(account.id);
  });
});

describe("unconfirmed session recovery", () => {
  it("protects a pending target from re-login when rollback left the actual account unknown", async () => {
    const { controller, account } = await fixture();
    await controller.store.prepare("rollback-agent", "codex", account.id);
    await controller.store.change(registry => {
      const binding = registry.bindings[0];
      binding.currentAccountId = null;
      binding.launchAccountId = "system-codex";
      binding.status = "error";
    });
    await expect(controller.login(paseo, account.id)).rejects.toThrow(/Switch agents away/);
    expect(mocks.launchLogin).not.toHaveBeenCalled();
    expect(accountFrom(await controller.store.read(), account.id).loginToken).toBeNull();
  });

  it("marks an interrupted switch unknown on startup and preserves its target reservation", async () => {
    const root = await newRoot();
    const store = new AccountStore(root);
    await store.initialize({ claude: join(root, "source-claude"), codex: join(root, "source-codex") });
    const target = await store.add("codex", "Target");
    await store.prepare("interrupted-agent", "codex", target.id);
    await store.change(registry => {
      const binding = registry.bindings[0];
      binding.status = "switching";
      binding.launchAccountId = target.id;
      binding.launchToken = "interrupted-launch";
    });
    const controller = await start(root);
    const binding = (await controller.store.snapshot()).bindings[0];
    expect(binding).toMatchObject({ currentAccountId: null, pendingAccountId: target.id, status: "error" });
    expect(binding.error).toContain("not confirmed");
    const stored = (await controller.store.read()).bindings[0];
    expect(stored.launchAccountId).toBe(target.id);
    await expect(controller.login(paseo, target.id)).rejects.toThrow(/Switch agents away/);
    await expect(controller.remove(target.id)).rejects.toThrow(/used by an agent/);
  });

  it("confirms a new default session only with the matching launch receipt and a live native session", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(registry => { registry.integration.enabled = true; registry.defaults.codex = account.id; });
    await controller.switcher(paseo).bindNewAgent("default-agent", "codex");
    const binding = (await controller.store.read()).bindings[0];
    expect((await controller.snapshot(paseo)).bindings[0].currentAccountId).toBeNull();
    await mkdir(join(controller.store.root, "receipts"), { recursive: true });
    const receiptPath = join(controller.store.root, "receipts", "default-agent.json");
    await writeFile(receiptPath, JSON.stringify({ accountId: account.id, launchToken: "stale-launch" }));
    expect((await controller.snapshot(paseo)).bindings[0].currentAccountId).toBeNull();
    await writeFile(receiptPath, JSON.stringify({ accountId: account.id, launchToken: binding.launchToken }));
    const unavailable = { agents: { ref: () => ({ refresh: async () => null }) } } as unknown as PaseoApi;
    expect((await controller.snapshot(unavailable)).bindings[0].currentAccountId).toBeNull();
    expect((await controller.snapshot(paseo)).bindings[0].currentAccountId).toBe(account.id);
  });
});

function completeAgentPage(ids: string[], nextCursor: string | null = null) {
  return { entries: ids.map(id => ({ agent: { id, archivedAt: id.startsWith("archived") ? "2026-09-16T00:00:00Z" : null } })), pageInfo: { hasMore: nextCursor !== null, nextCursor, prevCursor: null } };
}

describe("deleted agent reconciliation", () => {
  it("protects the default before registration, then releases it after observed registration and deletion", async () => {
    const { controller, account } = await fixture();
    await controller.setDefault("codex", account.id);
    await controller.store.change(r => { r.integration.enabled = true; });
    await controller.switcher(paseo).bindNewAgent("creating-agent", "codex");
    const host = { agents: { ...paseo.agents, list: async () => completeAgentPage([]) } } as unknown as PaseoApi;
    await controller.snapshot(host);
    expect((await controller.store.read()).bindings[0]).toMatchObject({ agentId: "creating-agent", registrationObserved: false, launchAccountId: account.id });
    await expect(controller.remove(account.id, host)).rejects.toThrow(/used/);
    await controller.observeAgentRegistration("creating-agent");
    await controller.snapshot(host);
    expect((await controller.store.read()).bindings).toEqual([]);
  });

  it("releases deleted-agent bindings for login while retaining archived agents across every page", async () => {
    const { controller, account } = await fixture();
    await controller.store.prepare("deleted-agent", "codex", account.id);
    await controller.store.change(r => { r.bindings[0].currentAccountId = account.id; r.bindings[0].launchAccountId = account.id; });
    await controller.store.prepare("archived-agent", "codex", "system-codex");
    const list = vi.fn().mockResolvedValueOnce(completeAgentPage(["active-agent"], "second-page")).mockResolvedValueOnce(completeAgentPage(["archived-agent"]));
    const host = { agents: { ...paseo.agents, list } } as unknown as PaseoApi;
    await expect(controller.login(host, account.id)).resolves.toMatchObject({ terminalId: "login-terminal" });
    expect((await controller.store.read()).bindings.map(b => b.agentId)).toEqual(["archived-agent"]);
    expect(list).toHaveBeenNthCalledWith(1, { filter: { includeArchived: true }, page: { limit: 200 } });
    expect(list).toHaveBeenNthCalledWith(2, { filter: { includeArchived: true }, page: { limit: 200, cursor: "second-page" } });
  });

  it("lets the removal RPC path clear a deleted binding but protects an archived binding", async () => {
    const { controller, account } = await fixture();
    await controller.store.prepare("deleted-agent", "codex", account.id);
    const host = { agents: { ...paseo.agents, list: async () => completeAgentPage([]) } } as unknown as PaseoApi;
    await controller.remove(account.id, host);
    expect((await controller.store.read()).accounts.some(a => a.id === account.id)).toBe(false);
    const archivedAccount = await controller.store.add("codex", "Archived owner");
    await controller.store.prepare("archived-agent", "codex", archivedAccount.id);
    const archivedHost = { agents: { ...paseo.agents, list: async () => completeAgentPage(["archived-agent"]) } } as unknown as PaseoApi;
    await expect(controller.remove(archivedAccount.id, archivedHost)).rejects.toThrow(/used by an agent/);
  });

  it.each(["request error", "missing page cursor", "repeated page cursor", "duplicate entries"])("retains every binding after an incomplete listing: %s", async failure => {
    const { controller, account } = await fixture(); await controller.store.prepare("protected-agent", "codex", account.id);
    const list = vi.fn();
    if (failure === "request error") list.mockResolvedValueOnce(completeAgentPage([], "next")).mockRejectedValueOnce(new Error("offline"));
    else if (failure === "missing page cursor") list.mockResolvedValue({ entries: [], pageInfo: { hasMore: true, nextCursor: null } });
    else if (failure === "duplicate entries") list.mockResolvedValueOnce(completeAgentPage(["duplicate"], "next")).mockResolvedValueOnce(completeAgentPage(["duplicate"]));
    else list.mockResolvedValue(completeAgentPage([], "same-page"));
    await controller.snapshot({ agents: { ...paseo.agents, list } } as unknown as PaseoApi);
    expect((await controller.store.read()).bindings.map(b => b.agentId)).toEqual(["protected-agent"]);
  });

  it("preserves bindings created while the full listing is in flight", async () => {
    const { controller, account } = await fixture(); await controller.store.prepare("deleted-agent", "codex", account.id);
    let finish!: (value: ReturnType<typeof completeAgentPage>) => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const list = vi.fn(() => { started(); return new Promise<ReturnType<typeof completeAgentPage>>(resolve => { finish = resolve; }); });
    const snapshot = controller.snapshot({ agents: { ...paseo.agents, list } } as unknown as PaseoApi);
    await entered; await controller.store.prepare("new-agent", "codex", account.id); finish(completeAgentPage([])); await snapshot;
    expect((await controller.store.read()).bindings.map(b => b.agentId)).toEqual(["new-agent"]);
  });
});

describe("confirmation token lifecycle", () => {
  it("consumes a successful confirmation and never resurrects its receipt after integration is disabled", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(r => { r.integration.enabled = true; r.defaults.codex = account.id; });
    await controller.switcher(paseo).bindNewAgent("receipt-agent", "codex");
    const token = (await controller.store.read()).bindings[0].launchToken;
    await mkdir(join(controller.store.root, "receipts"), { recursive: true });
    await writeFile(join(controller.store.root, "receipts", "receipt-agent.json"), JSON.stringify({ accountId: account.id, launchToken: token }));
    await controller.snapshot(paseo);
    expect((await controller.store.read()).bindings[0]).toMatchObject({ currentAccountId: account.id, launchToken: null });
    await controller.integration(paseo, false);
    await controller.store.change(r => { r.integration.enabled = true; });
    await controller.store.prepare("receipt-agent", "codex", "system-codex");
    expect((await controller.snapshot(paseo)).bindings[0].currentAccountId).toBeNull();
    expect((await controller.store.read()).bindings[0].launchToken).toBeNull();
  });

  it("does not confirm a pending receipt while integration is disabled", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(r => { r.integration.enabled = true; r.defaults.codex = account.id; });
    await controller.switcher(paseo).bindNewAgent("disabled-agent", "codex");
    const token = (await controller.store.read()).bindings[0].launchToken;
    await mkdir(join(controller.store.root, "receipts"), { recursive: true });
    await writeFile(join(controller.store.root, "receipts", "disabled-agent.json"), JSON.stringify({ accountId: account.id, launchToken: token }));
    await controller.store.change(r => { r.integration.enabled = false; });
    expect((await controller.snapshot(paseo)).bindings[0].currentAccountId).toBeNull();
  });
});

describe("default account authentication", () => {
  it("requires a ready official auth probe before persisting a new default", async () => {
    const { controller, account } = await fixture();
    mocks.probeAccount.mockResolvedValueOnce({ identityKey: null, email: null, plan: null, authStatus: "needs_auth" });
    await expect(controller.setDefault("codex", account.id)).rejects.toThrow(/Sign in|authentication/);
    expect((await controller.store.read()).defaults.codex).toBeNull();
    await controller.setDefault("codex", account.id);
    expect((await controller.store.read()).defaults.codex).toBe(account.id);
  });
});

describe("owned login artifact removal", () => {
  it("refuses redirected cleanup parents before deleting credentials or unrelated files", async () => {
    const { controller, account } = await fixture();
    const unrelated = join(controller.store.root, "unrelated"); await mkdir(unrelated);
    await mkdir(join(unrelated, account.id)); await writeFile(join(unrelated, account.id, "keep"), "preserve");
    await symlink(unrelated, join(controller.store.root, "login"));
    await expect(controller.remove(account.id)).rejects.toThrow(/redirected/);
    expect(mocks.removeAccountCredentials).not.toHaveBeenCalled();
    expect(accountFrom(await controller.store.read(), account.id).id).toBe(account.id);
    await expect(access(join(unrelated, account.id, "keep"))).resolves.toBeUndefined();
  });

  it("removes this account's login directory and receipt while preserving sibling and symlink targets", async () => {
    const { controller, account } = await fixture();
    const directory = join(controller.store.root, "login", account.id), sibling = join(controller.store.root, "login", "other-account");
    await mkdir(directory, { recursive: true }); await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "keep"), "preserve"); await symlink(sibling, join(directory, "shared"));
    await loginReceipt(controller.store.root, account.id, "completed"); await loginReceipt(controller.store.root, "other-account", "keep");
    await controller.remove(account.id);
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(controller.store.root, "logins", `${account.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(sibling, "keep"))).resolves.toBeUndefined();
    await expect(access(join(controller.store.root, "logins", "other-account.json"))).resolves.toBeUndefined();
  });
});

describe("live integration reconciliation", () => {
  it("rechecks actual provider ownership on each action while caching expensive discovery", async () => {
    const { controller } = await fixture();
    await controller.ensureRuntime(paseo); await controller.ensureRuntime(paseo);
    expect(mocks.prepareRuntime).toHaveBeenCalledExactlyOnceWith(paseo, controller.store);
    expect(mocks.reconcileIntegration).toHaveBeenCalledTimes(2);
  });

  it("blocks apply before its auth probe when commands have drifted since discovery", async () => {
    const { controller, account } = await fixture(); await controller.ensureRuntime(paseo);
    await controller.store.change(r => { r.integration.enabled = true; });
    await controller.store.prepare("drift-agent", "codex", account.id);
    mocks.reconcileIntegration.mockImplementationOnce(async () => {
      await controller.store.change(r => { r.integration = { enabled: false, error: "Provider ownership changed" }; });
    });
    await expect(controller.switcher(paseo).apply("drift-agent")).rejects.toThrow(/integration/i);
    expect(mocks.probeAccount).not.toHaveBeenCalled();
    expect((await controller.store.read()).bindings[0].launchToken).toBeNull();
  });

  it("rechecks ownership immediately before reload when drift occurs during the auth probe", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(r => { r.integration.enabled = true; });
    await controller.store.prepare("late-drift-agent", "codex", account.id);
    let drifted = false;
    mocks.probeAccount.mockImplementationOnce(async () => { drifted = true; return { identityKey: "fixture-account", email: null, plan: "plus", authStatus: "ready" }; });
    mocks.reconcileIntegration.mockImplementation(async () => {
      if (!drifted) return;
      await controller.store.change(r => {
        r.integration = { enabled: false, error: "Provider ownership changed" };
        for (const binding of r.bindings) { binding.launchToken = null; binding.currentAccountId = null; binding.status = "error"; }
      });
    });
    await expect(controller.switcher(paseo).apply("late-drift-agent")).rejects.toThrow(/integration/i);
    expect(mocks.reconcileIntegration).toHaveBeenCalledTimes(2);
    expect((await controller.store.read()).bindings[0]).toMatchObject({ currentAccountId: null, launchToken: null, status: "error" });
  });
});
