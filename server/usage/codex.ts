import { spawn } from "node:child_process";
import { UsageError, type CollectedUsage, type QuotaAccount } from "./index";
import { object, parseCodexUsage, string } from "./parsers";

/** A short-lived native app-server session. No thread, prompt, login or forced refresh. */
export async function collectCodexUsage(account: QuotaAccount, signal?: AbortSignal): Promise<CollectedUsage> {
  const [executable, ...args] = account.command;
  if (!executable) throw new UsageError("unavailable", "missing_cli");
  const child = spawn(executable, [...args, "app-server"], { cwd: account.home, env: account.env, stdio: ["pipe", "pipe", "ignore"] });
  let sequence = 0;
  let buffer = "";
  let failed: UsageError | null = null;
  const pending = new Map<number, {resolve: (value: unknown) => void; reject: (error: UsageError) => void}>();
  const fail = (code: string) => {
    failed = new UsageError("unavailable", code);
    for (const request of pending.values()) request.reject(failed);
    pending.clear();
  };
  child.on("error", () => fail("cli_start_failed"));
  child.on("exit", () => fail("cli_exited"));
  child.stdin.on("error", () => fail("cli_pipe_failed"));
  const abort = () => { fail("cancelled"); child.kill(); };
  signal?.addEventListener("abort", abort, {once:true});
  const timeout = setTimeout(() => { fail("cli_timeout"); child.kill(); }, 15000);
  timeout.unref();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 2 * 1024 * 1024) { fail("cli_output_limit"); child.kill(); return; }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0,newline); buffer = buffer.slice(newline + 1);
      let message: Record<string, unknown> | null;
      try { message = object(JSON.parse(line)); } catch { continue; }
      if (!message) continue;
      const request = pending.get(message.id as number);
      if (!request) continue;
      pending.delete(message.id as number);
      if (message.error) {
        const raw = object(message.error);
        const status = raw?.code === 401 || /unauthorized|not authenticated|not logged in|authentication required/i.test(string(raw?.message) ?? "") ? "needs_auth" : "unavailable";
        request.reject(new UsageError(status, "cli_request_failed"));
      } else request.resolve(message.result);
    }
  });
  function request(method: string, params: unknown): Promise<unknown> {
    if (failed) return Promise.reject(failed);
    const id = ++sequence;
    return new Promise((resolve, reject) => { pending.set(id,{resolve,reject}); child.stdin.write(`${JSON.stringify({id,method,params})}\n`); });
  }
  try {
    if (signal?.aborted) throw new UsageError("unavailable", "cancelled");
    await request("initialize", {clientInfo:{name:"paseo_account_switcher",version:"0.1.0"}});
    child.stdin.write(`${JSON.stringify({method:"initialized",params:{}})}\n`);
    const identity = object(await request("account/read", {refreshToken:false}));
    const signedIn = object(identity?.account);
    if (!signedIn) throw new UsageError("needs_auth", "missing_auth");
    if (signedIn.type !== "chatgpt") throw new UsageError("unavailable", "subscription_required");
    const usage = parseCodexUsage(await request("account/rateLimits/read", {}));
    if (account.identityKey && usage.identityKey && account.identityKey !== usage.identityKey) throw new UsageError("needs_auth", "identity_changed");
    if (!usage.windows.length) throw new UsageError("unavailable", "invalid_payload");
    return {...usage, plan:usage.plan ?? string(signedIn.planType)};
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError("unavailable", "cli_failed");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    child.stdin.end();
    child.kill();
    // Do not leave an uncooperative CLI running after the request has completed.
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const force = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 500);
        child.once("close", () => { clearTimeout(force); resolve(); });
      });
    }
  }
}
