import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { AccountStore } from "../server/store";
import { accountEnvironment, launchLogin, probeAccount, removeAccountCredentials } from "../server/auth";
import { installIntegration, launcherPath, prepareRuntime, reconcileIntegration, restoreIntegration, writeLaunchers } from "../server/integration";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "account runtime space ")); roots.push(root);
  const store = new AccountStore(root);
  await store.initialize({ claude: join(root, "source claude"), codex: join(root, "source codex") });
  const cli = join(root, "fake cli.cjs");
  await writeFile(cli, `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('status')) {
 if(process.env.FAKE_FAIL) { console.error('private-secret'); process.exit(1); }
 if(args.includes('auth')) console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'person@example.test',orgId:'org',subscriptionType:'max'}));
 else console.error('Logged in using ChatGPT');
} else if(args.includes('--wait')) {
 console.log('ready'); process.on('SIGTERM',()=>{console.log('terminated');process.exit(23)}); setInterval(()=>{},1000);
} else {
 console.log(JSON.stringify({args,home:process.env.CODEX_HOME,claudeHome:process.env.CLAUDE_CONFIG_DIR,key:process.env.OPENAI_API_KEY,custom:process.env.CUSTOM}));
 process.stdin.pipe(process.stdout);
}
`);
  await store.change(registry => { registry.commands = { claude: [process.execPath, cli], codex: [process.execPath, cli] }; });
  return { root, store, cli };
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv, input = "") {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "pipe" });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })); child.stdin.end(input);
  });
}

describe("standalone native-provider launcher", () => {
  it("selects the bound profile, shares history, preserves argv/stdin, and writes a correlated receipt", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Work");
    await mkdir(account.home, { recursive: true });
    await store.prepare("agent/one", "codex", account.id);
    await store.change(registry => { const binding = registry.bindings[0]; binding.launchAccountId = account.id; binding.launchToken = "launch-1"; });
    await writeLaunchers(store);
    const result = await run(launcherPath(root, "codex"), ["app-server", "argument with spaces", "$(touch nope)"], { ...process.env, PASEO_AGENT_ID: "agent/one", OPENAI_API_KEY: "secret", CUSTOM: "kept" }, "byte-transparent\n");
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    const [first, ...rest] = result.stdout.split("\n");
    expect(JSON.parse(first)).toMatchObject({ home: account.home, custom: "kept", args: ["app-server", "argument with spaces", "$(touch nope)"] });
    expect(JSON.parse(first).key).toBeUndefined(); expect(rest.join("\n")).toBe("byte-transparent\n");
    const receipt = JSON.parse(await readFile(join(root, "receipts", "agent%2Fone.json"), "utf8"));
    expect(receipt).toMatchObject({ accountId: account.id, launchToken: "launch-1" }); expect(receipt.pid).toBeGreaterThan(0);
    expect(await readFile(join(account.home, "config.toml"), "utf8")).toContain('cli_auth_credentials_store = "file"');
    expect((await stat(launcherPath(root, "codex"))).mode & 0o777).toBe(0o700);
  });

  it("preserves original environment and command arguments for unmanaged sessions", async () => {
    const { root, store } = await fixture();
    await store.change(registry => { registry.commands.codex!.push("prefix with spaces"); });
    await writeLaunchers(store);
    const result = await run(launcherPath(root, "codex"), ["--version"], { ...process.env, CODEX_HOME: "/user/original home", OPENAI_API_KEY: "original-key" });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ args: ["prefix with spaces", "--version"], home: "/user/original home", key: "original-key" });
  });

  it("fails explicitly when an assigned profile disappears", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Gone");
    await store.prepare("assigned", "codex", account.id);
    await store.change(registry => { registry.bindings[0].launchAccountId = account.id; });
    await writeLaunchers(store);
    const result = await run(launcherPath(root, "codex"), ["app-server"], { ...process.env, PASEO_AGENT_ID: "assigned" });
    expect(result.code).not.toBe(0); expect(result.stdout).toBe(""); expect(result.stderr).toContain("profile");
  });

  it("refuses a profile redirected to the shared home by a symlink", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Redirected");
    const source = (await store.read()).sourceHomes.codex;
    await mkdir(join(root, "accounts", account.id), { recursive: true }); await mkdir(source, { recursive: true });
    await symlink(source, account.home);
    await store.prepare("assigned", "codex", account.id);
    await store.change(registry => { registry.bindings[0].launchAccountId = account.id; });
    await writeLaunchers(store);
    const result = await run(launcherPath(root, "codex"), ["app-server"], { ...process.env, PASEO_AGENT_ID: "assigned" });
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("profile");
  });

  it("does not reveal corrupt registry content or run an original command", async () => {
    const { root, store } = await fixture(); await writeLaunchers(store);
    await writeFile(join(root, "registry.json"), "{ private-secret-invalid-json");
    const result = await run(launcherPath(root, "codex"), ["app-server"], process.env);
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("registry"); expect(result.stderr).not.toContain("private-secret");
  });

  it("rejects prefix arguments that override the selected subscription account", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Protected");
    await mkdir(account.home, { recursive: true }); await store.prepare("assigned", "codex", account.id);
    await store.change(registry => { registry.bindings[0].launchAccountId = account.id; registry.commands.codex!.push("-c", 'model_provider="proxy"'); });
    await writeLaunchers(store);
    const result = await run(launcherPath(root, "codex"), ["app-server"], { ...process.env, PASEO_AGENT_ID: "assigned" });
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("isolation");
  });

  it("forwards SIGTERM to the official process and preserves its exit code", async () => {
    const { root, store } = await fixture(); await writeLaunchers(store);
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(launcherPath(root, "codex"), ["--wait"], { env: process.env, stdio: "pipe" }); let output = "";
      child.on("error", reject); child.stdout.on("data", data => { output += data; if (String(data).includes("ready")) child.kill("SIGTERM"); });
      child.on("close", code => resolve({ code, output }));
    });
    expect(result).toEqual({ code: 23, output: "ready\nterminated\n" });
  });

  it("runs official isolated login and records completion only after its exit", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Login");
    await mkdir(account.home, { recursive: true });
    await store.change(registry => { registry.accounts.find(row => row.id === account.id)!.loginToken = "login-1"; });
    await writeLaunchers(store);
    const result = await run(launcherPath(root, "codex"), ["--account-switcher-login", account.id], { ...process.env, OPENAI_API_KEY: "secret" });
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ args: ["login", "--device-auth"], home: account.home });
    expect(JSON.parse(result.stdout).key).toBeUndefined();
    expect(JSON.parse(await readFile(join(root, "logins", `${account.id}.json`), "utf8"))).toMatchObject({ loginToken: "login-1", exitCode: 0 });
  });

  it("records a sanitized failed-login receipt if the official binary cannot start", async () => {
    const { root, store } = await fixture(); const account = await store.add("claude", "Login");
    await mkdir(account.home, { recursive: true });
    await store.change(registry => { registry.accounts.find(row => row.id === account.id)!.loginToken = "login-failed"; registry.commands.claude = [join(root, "missing-secret-path")]; });
    await writeLaunchers(store);
    const result = await run(launcherPath(root, "claude"), ["--account-switcher-login", account.id], process.env);
    expect(result.code).toBe(1); expect(result.stderr).not.toContain("missing-secret-path");
    expect(JSON.parse(await readFile(join(root, "logins", `${account.id}.json`), "utf8"))).toMatchObject({ loginToken: "login-failed", exitCode: 1 });
  });
});

describe("auth and config integration", () => {
  it("deletes only the managed Claude Keychain namespace and never the system service", async () => {
    const { store } = await fixture(); const account = await store.add("claude", "Delete me");
    const remove = vi.fn(async () => {}), registry = await store.read();
    await removeAccountCredentials(account, registry, { platform: "darwin", remove });
    const suffix = createHash("sha256").update(account.home.normalize("NFC")).digest("hex").slice(0, 8);
    expect(remove).toHaveBeenCalledExactlyOnceWith(["delete-generic-password", "-a", process.env.USER && /^[a-zA-Z0-9._-]+$/.test(process.env.USER) ? process.env.USER : "claude-code-user", "-s", `Claude Code-credentials-${suffix}`]);
    await expect(removeAccountCredentials(registry.accounts[0], registry, { platform: "darwin", remove })).rejects.toThrow();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("keeps the default system Claude Keychain namespace and pins explicit source environments", async () => {
    const { store } = await fixture(), registry = await store.read();
    const claude = registry.accounts.find(account => account.provider === "claude")!;
    expect(accountEnvironment(claude, registry, { CLAUDE_CONFIG_DIR: "/wrong", ANTHROPIC_API_KEY: "system-key" })).toEqual({ ANTHROPIC_API_KEY: "system-key" });
    registry.sourceEnvironment.claude = { CLAUDE_CONFIG_DIR: claude.home, CLAUDE_SECURESTORAGE_CONFIG_DIR: claude.home };
    expect(accountEnvironment(claude, registry, {})).toEqual(registry.sourceEnvironment.claude);
    const codex = registry.accounts.find(account => account.provider === "codex")!;
    expect(accountEnvironment(codex, registry, { CODEX_HOME: "/wrong", OPENAI_API_KEY: "system-key" })).toEqual({ CODEX_HOME: codex.home, OPENAI_API_KEY: "system-key" });
  });

  it("probes Claude through the official CLI and exposes metadata only", async () => {
    const { store } = await fixture(); const account = await store.add("claude", "Claude"); await mkdir(account.home, { recursive: true });
    expect(await probeAccount(account, await store.read())).toMatchObject({ email: "person@example.test", plan: "max", authStatus: "ready" });
    const env = accountEnvironment(account, await store.read(), { ANTHROPIC_API_KEY: "secret", CUSTOM: "yes" });
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: account.home, CUSTOM: "yes" });
  });

  it("decodes Codex identity without returning token material", async () => {
    const { store } = await fixture(); const account = await store.add("codex", "Codex"); await mkdir(account.home, { recursive: true });
    const payload = Buffer.from(JSON.stringify({ email: "codex@example.test", sub: "user-1", "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus" } })).toString("base64url");
    await writeFile(join(account.home, "auth.json"), JSON.stringify({ tokens: { id_token: `header.${payload}.signature`, access_token: "must-never-return", account_id: "acct-1" } }));
    const result = await probeAccount(account, await store.read());
    expect(result).toMatchObject({ identityKey: "acct-1", email: "codex@example.test", plan: "plus", authStatus: "ready" });
    expect(JSON.stringify(result)).not.toContain("must-never-return"); expect(JSON.stringify(result)).not.toContain(payload);
  });

  it("installs once, preserves provider settings and original args, and restores only owned commands", async () => {
    const { root, store, cli } = await fixture();
    let config = { providers: { claude: { command: [process.execPath, cli, "original arg"], enabled: true, custom: "keep" }, codex: { command: [process.execPath, cli], enabled: true }, other: { command: ["other"] } } };
    const patch = vi.fn(async (change) => { config = { ...config, providers: { ...config.providers, ...change.providers } }; return { config }; });
    const paseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    await installIntegration(paseo, store); await installIntegration(paseo, store);
    expect(config.providers.claude).toMatchObject({ command: [launcherPath(root, "claude")], custom: "keep" });
    expect((await store.read()).originalCommands.claude).toEqual([process.execPath, cli, "original arg"]);
    config.providers.codex.command = ["user-replacement"];
    await restoreIntegration(paseo, store);
    expect(config.providers.claude.command).toEqual([process.execPath, cli, "original arg"]);
    expect(config.providers.codex.command).toEqual(["user-replacement"]); expect(config.providers.other.command).toEqual(["other"]);
  });

  it("opens login in a safe Paseo workspace with argv arrays", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Account");
    await mkdir(account.home, { recursive: true });
    const create = vi.fn(async () => ({ id: "terminal-id" })), setTitle = vi.fn();
    const open = vi.fn(async () => ({ id: "workspace-id", setTitle }));
    const paseo = { workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }), open }, terminals: { create } } as unknown as PaseoApi;
    expect(await launchLogin(paseo, store, account.id)).toEqual({ terminalId: "terminal-id", workspaceId: "workspace-id" });
    expect(open).toHaveBeenCalledWith({ cwd: join(root, "login", account.id) }); expect(setTitle).toHaveBeenCalledWith("Sign in · Codex · Account");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ command: launcherPath(root, "codex"), args: ["--account-switcher-login", account.id], cwd: join(root, "login", account.id) }));
  });

  it("opens the chosen Codex browser login directly through a Paseo terminal", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Browser account");
    await mkdir(account.home, { recursive: true });
    await store.change(registry => { registry.accounts.find(row => row.id === account.id)!.loginToken = "browser-login"; });
    const create = vi.fn(async (_options: Parameters<PaseoApi["terminals"]["create"]>[0]) => ({ id: "browser-terminal" })), setTitle = vi.fn();
    const paseo = { workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }), open: vi.fn(async () => ({ id: "browser-workspace", setTitle })) }, terminals: { create } } as unknown as PaseoApi;
    expect(await launchLogin(paseo, store, account.id, undefined, "browser")).toEqual({ terminalId: "browser-terminal", workspaceId: "browser-workspace" });
    expect(setTitle).toHaveBeenCalledWith("Sign in · Codex · Browser account");
    const options = create.mock.calls[0][0];
    expect(options).toMatchObject({ command: launcherPath(root, "codex"), args: ["--account-switcher-login", account.id, "--browser"] });
    const result = await run(options.command!, options.args!, process.env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ args: ["login"], home: account.home });
    expect(JSON.parse(await readFile(join(root, "logins", `${account.id}.json`), "utf8"))).toMatchObject({ loginToken: "browser-login", exitCode: 0 });
  });

  it("keeps supplied workspace ownership while isolating Claude's login working directory", async () => {
    const { root, store } = await fixture(); const account = await store.add("claude", "Claude account");
    await mkdir(account.home, { recursive: true });
    const create = vi.fn(async () => ({ id: "claude-terminal" })), open = vi.fn();
    const paseo = { workspaces: { open }, terminals: { create } } as unknown as PaseoApi;
    expect(await launchLogin(paseo, store, account.id, "existing-workspace", "browser")).toEqual({ terminalId: "claude-terminal", workspaceId: "existing-workspace" });
    expect(open).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "existing-workspace", command: launcherPath(root, "claude"), args: ["--account-switcher-login", account.id], cwd: join(root, "login", account.id) }));
  });

  it("reconciles external command drift without patching the user's replacement and preserves it on later restore", async () => {
    const { root, store, cli } = await fixture();
    let config = { providers: { claude: { command: [process.execPath, cli] }, codex: { command: [process.execPath, cli] } } };
    const patch = vi.fn(async change => { config = { providers: { ...config.providers, ...change.providers } }; return { config }; });
    const paseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    await installIntegration(paseo, store); patch.mockClear();
    config.providers.codex.command = [process.execPath, cli, "user-change"];
    await prepareRuntime(paseo, store);
    const registry = await store.read();
    expect(registry.integration.enabled).toBe(false); expect(registry.integration.error).toMatch(/commands/i);
    expect(registry.originalCommands.codex).toEqual([process.execPath, cli, "user-change"]);
    expect(config.providers.claude.command).toEqual([launcherPath(root, "claude")]); expect(patch).not.toHaveBeenCalled();
    await installIntegration(paseo, store);
    expect((await store.read()).integration).toEqual({ enabled: true, error: null });
    await restoreIntegration(paseo, store);
    expect(config.providers.codex.command).toEqual([process.execPath, cli, "user-change"]);
  });

  it("marks integration unavailable when externally replaced commands cannot be resolved", async () => {
    const { store, cli } = await fixture();
    let config = { providers: { claude: { command: [process.execPath, cli] }, codex: { command: [process.execPath, cli] } } };
    const patch = vi.fn(async change => { config = { providers: { ...config.providers, ...change.providers } }; return { config }; });
    const paseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    await installIntegration(paseo, store); patch.mockClear();
    config.providers.codex.command = ["/nonexistent/account-switcher-fixture-cli"];
    await expect(prepareRuntime(paseo, store)).rejects.toThrow(/CLI/);
    expect((await store.read()).integration).toMatchObject({ enabled: false, error: expect.any(String) });
    expect(patch).not.toHaveBeenCalled();
  });

  it("revokes pending launch receipts on live drift and requires explicit enable after wrapper ownership returns", async () => {
    const { root, store, cli } = await fixture();
    let config = { providers: { claude: { command: [process.execPath, cli] }, codex: { command: [process.execPath, cli] } } };
    const patch = vi.fn(async change => { config = { providers: { ...config.providers, ...change.providers } }; return { config }; });
    const paseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    await installIntegration(paseo, store); patch.mockClear();
    await store.change(state => {
      state.bindings.push({ agentId: "in-flight", provider: "codex", currentAccountId: "system-codex", pendingAccountId: "system-codex", launchAccountId: "system-codex", launchToken: "old-switch-receipt", status: "switching", error: null, registrationObserved: true });
      state.bindings.push({ agentId: "default-start", provider: "claude", currentAccountId: null, pendingAccountId: null, launchAccountId: "system-claude", launchToken: "old-default-receipt", status: "ready", error: null, registrationObserved: false });
      state.bindings.push({ agentId: "confirmed", provider: "claude", currentAccountId: "system-claude", pendingAccountId: null, launchAccountId: "system-claude", launchToken: null, status: "ready", error: null, registrationObserved: true });
    });
    const launcherBefore = await stat(launcherPath(root, "claude"));
    config.providers.codex.command = ["/not-resolvable-and-must-not-be-resolved"];
    await reconcileIntegration(paseo, store);
    const registry = await store.read();
    expect(registry.integration.enabled).toBe(false);
    expect(registry.bindings.slice(0, 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "in-flight", currentAccountId: null, launchToken: null, status: "error" }),
      expect.objectContaining({ agentId: "default-start", currentAccountId: null, launchToken: null, status: "error" }),
    ]));
    expect(registry.bindings[2]).toMatchObject({ currentAccountId: "system-claude", status: "ready" });
    expect((await stat(launcherPath(root, "claude"))).ino).toBe(launcherBefore.ino);
    expect(patch).not.toHaveBeenCalled();
    config.providers.codex.command = [launcherPath(root, "codex")];
    await reconcileIntegration(paseo, store);
    await prepareRuntime(paseo, store);
    expect((await store.read()).integration.enabled).toBe(false);
    await installIntegration(paseo, store);
    expect((await store.read()).integration).toEqual({ enabled: true, error: null });
    expect((await store.read()).bindings.every(binding => binding.launchToken === null)).toBe(true);
  });

  it("fails closed on unavailable live config without exposing raw errors", async () => {
    const { store } = await fixture(); await store.change(state => { state.integration.enabled = true; });
    const paseo = { config: { get: async () => { throw new Error("fixture-private-config-value"); } } } as unknown as PaseoApi;
    await expect(reconcileIntegration(paseo, store)).rejects.toThrow("Could not verify Paseo provider commands");
    const registry = await store.read();
    expect(registry.integration.enabled).toBe(false); expect(JSON.stringify(registry)).not.toContain("fixture-private-config-value");
  });

  it.each([
    ["claude", "ANTHROPIC_API_KEY"], ["claude", "CLAUDE_CODE_OAUTH_TOKEN"], ["claude", "ANTHROPIC_BASE_URL"],
    ["codex", "OPENAI_API_KEY"], ["codex", "CODEX_API_KEY"], ["codex", "OPENAI_BASE_URL"],
  ])("rejects %s provider auth override %s without copying its value or patching config", async (provider, key) => {
    const { store, cli } = await fixture();
    const config = { providers: { claude: { command: [process.execPath, cli], env: {} }, codex: { command: [process.execPath, cli], env: {} } } };
    (config.providers as Record<string, { env: Record<string, string> }>)[provider].env[key] = "fixture-private-value";
    const patch = vi.fn(), paseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    await store.change(registry => { registry.integration.enabled = true; });
    await expect(reconcileIntegration(paseo, store)).rejects.toThrow("Could not verify Paseo provider commands");
    await expect(prepareRuntime(paseo, store)).rejects.toThrow(/authentication/);
    const registry = await store.read();
    expect(registry.integration.enabled).toBe(false);
    expect(JSON.stringify(registry)).not.toContain("fixture-private-value"); expect(patch).not.toHaveBeenCalled();
  });

  it("rejects ambient source auth overrides but accepts ordinary provider environment and supported profile paths", async () => {
    const { root, store, cli } = await fixture();
    const config = { providers: { claude: { command: [process.execPath, cli], env: { CUSTOM: "ordinary", CLAUDE_CONFIG_DIR: join(root, "claude-home") } }, codex: { command: [process.execPath, cli], env: { CUSTOM: "ordinary", CODEX_HOME: join(root, "codex-home") } } } };
    const patch = vi.fn(), paseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    vi.stubEnv("OPENAI_API_KEY", "fixture-ambient-private");
    await expect(prepareRuntime(paseo, store)).rejects.toThrow(/authentication/);
    expect(JSON.stringify(await store.read())).not.toContain("fixture-ambient-private");
    vi.unstubAllEnvs();
    await prepareRuntime(paseo, store);
    expect((await store.read()).sourceHomes).toEqual({ claude: join(root, "claude-home"), codex: join(root, "codex-home") });
    expect(patch).not.toHaveBeenCalled();
  });

  it("reuses the exact login workspace across attempts and pages while leaving unrelated and archiving workspaces alone", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Account"); await mkdir(account.home, { recursive: true });
    const cwd = join(root, "login", account.id);
    const list = vi.fn(async (options: { page: { cursor?: string } }) => options.page.cursor ? {
      entries: [{ id: "reusable", workspaceDirectory: cwd, archivingAt: null }], pageInfo: { hasMore: false, nextCursor: null },
    } : {
      entries: [{ id: "unrelated", workspaceDirectory: join(root, "project"), name: "Sign in · Codex · Account" }, { id: "archiving", workspaceDirectory: cwd, archivingAt: "2026-01-01T00:00:00Z" }],
      pageInfo: { hasMore: true, nextCursor: "next-page" },
    });
    const open = vi.fn(), archive = vi.fn(), create = vi.fn(async () => ({ id: "terminal-id" }));
    const paseo = { workspaces: { list, open, archive }, terminals: { create } } as unknown as PaseoApi;
    expect(await launchLogin(paseo, store, account.id)).toEqual({ terminalId: "terminal-id", workspaceId: "reusable" });
    expect(await launchLogin(paseo, store, account.id, undefined, "browser")).toEqual({ terminalId: "terminal-id", workspaceId: "reusable" });
    expect(list).toHaveBeenCalledTimes(4); expect(open).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled();
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: "reusable", cwd, args: ["--account-switcher-login", account.id, "--browser"] }));
  });
});
