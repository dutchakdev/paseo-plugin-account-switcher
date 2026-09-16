import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readRegistry } from "./store";
import { assertManagedCommand, buildAccountEnv, prepareProfile } from "./profiles";
import { atomicWrite } from "./files";

class LauncherError extends Error {}
let loginCompletion: { path: string; loginToken: string } | undefined;
async function finishLogin(exitCode: number): Promise<void> {
  if (loginCompletion) await atomicWrite(loginCompletion.path, JSON.stringify({ loginToken: loginCompletion.loginToken, exitCode, finishedAt: new Date().toISOString() }));
}

async function main(): Promise<void> {
  const executable = resolve(process.argv[1]), root = dirname(dirname(executable));
  const provider = basename(executable) === "claude-launcher" ? "claude" : basename(executable) === "codex-launcher" ? "codex" : null;
  if (!provider) throw new LauncherError("Unknown account launcher.");
  let registry;
  try { registry = await readRegistry(root); } catch { throw new LauncherError("Account registry is missing or corrupt; launch refused."); }
  const command = registry.commands[provider];
  if (!command?.[0] || !isAbsolute(command[0]) || [join(root, "bin", "claude-launcher"), join(root, "bin", "codex-launcher")].includes(resolve(command[0]))) throw new LauncherError("Original provider command is unavailable; launch refused.");
  let args = process.argv.slice(2), env = { ...process.env };
  const login = args[0] === "--account-switcher-login", agentId = env.PASEO_AGENT_ID;
  const binding = agentId ? registry.bindings.find(candidate => candidate.agentId === agentId && candidate.provider === provider) : undefined;
  const accountId = login ? args[1] : binding?.launchAccountId ?? binding?.currentAccountId;
  if (login && (!accountId || (args.length !== 2 && !(provider === "codex" && args.length === 3 && args[2] === "--browser")))) throw new LauncherError("Invalid account login arguments.");
  const account = accountId ? registry.accounts.find(candidate => candidate.id === accountId && candidate.provider === provider) : undefined;
  if (accountId && !account) throw new LauncherError("Assigned account profile is unavailable; launch refused.");
  if (login && account?.source !== "managed") throw new LauncherError("Only managed account profiles support this login command.");
  if (!login && account?.loginToken) throw new LauncherError("Account login is still in progress; launch refused.");
  if (account?.source === "managed") {
    if (!/^[a-zA-Z0-9_-]+$/.test(account.id) || resolve(account.home) !== join(root, "accounts", account.id, provider)) throw new LauncherError("Assigned account profile path is invalid; launch refused.");
    if (login) {
      if (!account.loginToken) throw new LauncherError("Start this account login from Paseo before running the login launcher.");
      loginCompletion = { path: join(root, "logins", `${account.id}.json`), loginToken: account.loginToken };
    }
    try { await assertManagedCommand(provider, [...command.slice(1), ...args]); }
    catch { throw new LauncherError("Provider arguments override account isolation; launch refused."); }
    try {
      if (!(await lstat(account.home)).isDirectory() || await realpath(account.home) !== join(await realpath(root), "accounts", account.id, provider)) throw new Error();
    } catch { throw new LauncherError("Assigned account profile is missing or redirected; launch refused. Restore the profile or select another account."); }
    try { await prepareProfile({ provider, home: account.home, sourceHome: registry.sourceHomes[provider], sourceEnvironment: registry.sourceEnvironment[provider] }); } catch { throw new LauncherError("Account profile preparation failed; inspect shared provider configuration."); }
    env = buildAccountEnv(provider, account.home, env);
  }
  if (login) args = provider === "claude" ? ["auth", "login", "--claudeai"] : args[2] === "--browser" ? ["login"] : ["login", "--device-auth"];
  const child = spawn(command[0], [...command.slice(1), ...args], { env, stdio: "inherit" });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const forward = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) { const handler = () => { child.kill(signal); }; forward.set(signal, handler); process.on(signal, handler); }
  let receipt: Promise<void> = Promise.resolve();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once("error", () => reject(new LauncherError("Could not start the configured provider CLI.")));
    child.once("spawn", () => {
      if (!login && binding && account && agentId) {
        receipt = atomicWrite(join(root, "receipts", `${encodeURIComponent(agentId)}.json`), JSON.stringify({ accountId: account.id, launchToken: binding.launchToken, pid: child.pid, at: new Date().toISOString() }));
        // A receipt failure cannot be treated as a successful identity switch.
        receipt.catch(() => { child.kill("SIGTERM"); });
      }
    });
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  const result = await exited;
  await receipt;
  await finishLogin(result.code ?? 1);
  for (const [signal, handler] of forward) process.removeListener(signal, handler);
  if (login && provider === "codex" && result.code !== 0) {
    const quoted = `'${executable.replace(/'/g, `'\\''`)}'`;
    process.stderr.write(`\nDevice login can require enabling device-code authentication in ChatGPT security settings. For browser login on this host, run:\n${quoted} --account-switcher-login ${account!.id} --browser\n`);
  }
  if (result.signal) { process.kill(process.pid, result.signal); return; }
  process.exitCode = result.code ?? 1;
}

main().catch(async error => {
  await finishLogin(1).catch(() => {});
  const safe = error instanceof LauncherError ? error.message : "Account launcher failed.";
  // Only errors constructed above leave this process. Filesystem/parse failures remain private.
  process.stderr.write(`Account switcher: ${safe}\n`);
  process.exitCode = 1;
});
