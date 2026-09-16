import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { Provider } from "../shared/contracts";
import { accountFrom, type AccountStore, type Registry, type StoredAccount } from "./store";
import { assertManagedCommand, buildAccountEnv, prepareProfile } from "./profiles";
import { launcherPath, writeLaunchers } from "./integration";

export function accountCommand(registry: Registry, provider: Provider): string[] {
  const command = registry.commands[provider];
  if (!command?.length || !command[0]) throw new Error("The provider CLI is not configured. Enable account integration.");
  return [...command];
}

export function accountEnvironment(account: StoredAccount, registry: Registry, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (account.source === "managed") return buildAccountEnv(account.provider, account.home, base);
  const env = { ...base };
  if (account.provider === "codex") env.CODEX_HOME = account.home;
  else {
    // An explicit CLAUDE_CONFIG_DIR changes Keychain's service, including ~/.claude.
    delete env.CLAUDE_CONFIG_DIR; delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    Object.assign(env, registry.sourceEnvironment.claude);
  }
  return env;
}

type CredentialRemovalDependencies = { platform?: string; remove?: (args: string[]) => Promise<void> };
export async function removeAccountCredentials(account: StoredAccount, registry: Registry, dependencies: CredentialRemovalDependencies = {}): Promise<void> {
  if (account.source !== "managed") throw new Error("Credentials for the current CLI cannot be removed through the plugin.");
  if (account.provider !== "claude" || (dependencies.platform ?? process.platform) !== "darwin") return;
  const home = resolve(account.home);
  if (!isAbsolute(account.home) || basename(home) !== "claude" || basename(dirname(home)) !== account.id || basename(dirname(dirname(home))) !== "accounts" || home === resolve(registry.sourceHomes.claude)) throw new Error("Invalid isolated Claude profile path; deletion was refused.");
  const suffix = createHash("sha256").update(account.home.normalize("NFC")).digest("hex").slice(0, 8);
  const user = process.env.USER;
  const args = ["delete-generic-password", "-a", user && /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user", "-s", `Claude Code-credentials-${suffix}`];
  const remove = dependencies.remove ?? ((arguments_: string[]) => new Promise<void>((resolveRemoval, reject) => {
    execFile("/usr/bin/security", arguments_, { timeout: 5000, maxBuffer: 64 * 1024 }, error => {
      if (!error || (error as { code?: string | number }).code === 44) resolveRemoval();
      else reject(new Error("Could not remove credentials for this Claude profile from Keychain. Check access and try again."));
    });
  }));
  try { await remove(args); } catch { throw new Error("Could not remove credentials for this Claude profile from Keychain. Check access and try again."); }
}

type Identity = Pick<StoredAccount, "identityKey" | "email" | "plan" | "authStatus">;
const empty = (authStatus: Identity["authStatus"]): Identity => ({ identityKey: null, email: null, plan: null, authStatus });
const string = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length < 1024 ? value : null;
const identity = (provider: Provider, fields: Array<string | null>): string | null => fields.some(Boolean)
  ? `${provider}:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}` : null;

async function status(command: string[], args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string; failed: boolean }> {
  return new Promise(resolve => {
    execFile(command[0], [...command.slice(1), ...args], { env, timeout: 20_000, maxBuffer: 256 * 1024, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? typeof error.code === "number" ? error.code : null : 0;
      resolve({ code, stdout, stderr, failed: !!error && code === null });
    });
  });
}

function decodeClaims(token: unknown): Record<string, unknown> {
  if (typeof token !== "string" || token.length > 128 * 1024) return {};
  try { const decoded = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); return decoded && typeof decoded === "object" ? decoded : {}; } catch { return {}; }
}

export async function probeAccount(account: StoredAccount, registry: Registry): Promise<Identity> {
  try {
    if (account.source === "managed") {
      if (!(await lstat(account.home)).isDirectory()) return empty("error");
      const root = dirname(dirname(dirname(account.home)));
      if (await realpath(account.home) !== join(await realpath(root), "accounts", account.id, account.provider)) return empty("error");
      await assertManagedCommand(account.provider, accountCommand(registry, account.provider).slice(1));
      await prepareProfile({ provider: account.provider, home: account.home, sourceHome: registry.sourceHomes[account.provider], sourceEnvironment: registry.sourceEnvironment[account.provider] });
    }
    const result = await status(accountCommand(registry, account.provider), account.provider === "claude" ? ["auth", "status", "--json"] : ["login", "status"], accountEnvironment(account, registry));
    if (result.failed) return empty("error");
    if (result.code !== 0) return empty("needs_auth");
    if (account.provider === "claude") {
      // Only the official status JSON is parsed; stderr is never exposed to callers.
      const value = JSON.parse(result.stdout.trim());
      if (value.loggedIn !== true) return empty("needs_auth");
      if (value.authMethod !== "claude.ai" && value.authMethod !== "oauth_token") return empty("unknown");
      const email = string(value.email), orgId = string(value.orgId);
      return { identityKey: identity("claude", [email, orgId]), email, plan: string(value.subscriptionType), authStatus: "ready" };
    }
    // `login status` intentionally has no JSON mode. Metadata comes only from this profile.
    if (!/logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`)) return empty("unknown");
    let auth;
    try { auth = JSON.parse(await readFile(join(account.home, "auth.json"), "utf8")); }
    catch (error) { return empty(account.source === "system" && (error as NodeJS.ErrnoException).code === "ENOENT" ? "unknown" : "error"); }
    if (!auth.tokens || typeof auth.tokens.access_token !== "string") return empty("unknown");
    const claims = decodeClaims(auth.tokens.id_token), access = decodeClaims(auth.tokens.access_token);
    const details = (claims["https://api.openai.com/auth"] ?? access["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
    const email = string(claims.email), accountId = string(auth.tokens.account_id) ?? string(details.chatgpt_account_id);
    if (!accountId) return empty("unknown");
    return { identityKey: accountId, email, plan: string(details.chatgpt_plan_type), authStatus: "ready" };
  } catch { return empty("error"); }
}

async function findLoginWorkspace(paseo: PaseoApi, cwd: string): Promise<string | undefined> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  try {
    do {
      const page = await paseo.workspaces.list({ page: { limit: 100, ...(cursor ? { cursor } : {}) } });
      const existing = page.entries.find(workspace => !workspace.archivingAt && resolve(workspace.workspaceDirectory ?? workspace.projectRootPath) === resolve(cwd));
      if (existing) return existing.id;
      if (!page.pageInfo.hasMore) return undefined;
      const next = page.pageInfo.nextCursor;
      if (!next || seen.has(next)) throw new Error("Invalid workspace pagination");
      seen.add(next); cursor = next;
    } while (cursor);
  } catch { throw new Error("Could not check the Paseo sign-in workspace. Try again."); }
}

export async function launchLogin(paseo: PaseoApi, store: AccountStore, accountId: string, workspaceId?: string, mode: "device" | "browser" = "device"): Promise<{ terminalId: string; workspaceId: string }> {
  const registry = await store.read(), account = accountFrom(registry, accountId);
  if (account.source !== "managed") throw new Error("Use the current CLI’s usual sign-in flow, or add a separate account for isolated sign-in.");
  accountCommand(registry, account.provider);
  try { await assertManagedCommand(account.provider, accountCommand(registry, account.provider).slice(1)); }
  catch { throw new Error("CLI arguments are incompatible with isolated sign-in. Remove provider authentication overrides."); }
  try {
    if (!(await lstat(account.home)).isDirectory() || await realpath(account.home) !== join(await realpath(store.root), "accounts", account.id, account.provider)) throw new Error();
    await prepareProfile({ provider: account.provider, home: account.home, sourceHome: registry.sourceHomes[account.provider], sourceEnvironment: registry.sourceEnvironment[account.provider] });
  } catch { throw new Error("The isolated profile is missing or invalid. Check its settings or create the account again."); }
  await writeLaunchers(store);
  const cwd = join(store.root, "login", account.id); await mkdir(cwd, { recursive: true, mode: 0o700 });
  if (!workspaceId) workspaceId = await findLoginWorkspace(paseo, cwd);
  if (!workspaceId) {
    const workspace = await paseo.workspaces.open({ cwd });
    await workspace.setTitle(`Sign in · ${account.provider === "codex" ? "Codex" : "Claude"} · ${account.label}`);
    workspaceId = workspace.id;
  }
  const args = ["--account-switcher-login", account.id];
  if (account.provider === "codex" && mode === "browser") args.push("--browser");
  try {
    const terminal = await paseo.terminals.create({ workspaceId, cwd, name: `${account.provider} · ${account.label}`, command: launcherPath(store.root, account.provider), args });
    return { terminalId: terminal.id, workspaceId };
  } catch { throw new Error("Could not open the Paseo sign-in terminal. Check that the workspace is active and the host supports terminals."); }
}
