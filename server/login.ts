import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { LoginSession } from "../shared/contracts";
import type { Registry, StoredAccount } from "./store";
import { accountCommand, accountEnvironment } from "./auth";
import { assertManagedCommand, prepareProfile } from "./profiles";
import { createLoginProcess, type CreateLoginProcess, type LoginProcess } from "./login-process";

type Entry = {
  value: LoginSession; process?: LoginProcess; timer?: ReturnType<typeof setTimeout>;
  buffer: string; nativeLoginId?: string; nativeSuccess: boolean; stopped: boolean;
  pendingCompletions: Array<Record<string, unknown>>; finishing?: Promise<void>;
};
export type LoginDependencies = {
  createProcess?: CreateLoginProcess; timeoutMs?: number;
  finish: (accountId: string, sessionId: string, successful: boolean) => Promise<boolean>;
};
const stale = () => new Error("This sign-in attempt is no longer active. Start sign-in again.");
const clearDetails = (value: LoginSession) => { value.authorizationUrl = null; value.userCode = null; value.canSubmitCode = false; };
function loginUrl(value: unknown, provider: "claude" | "codex", mode?: "device" | "browser"): string | null {
  if (typeof value !== "string" || value.length > 16384 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const hosts = provider === "claude" ? ["claude.ai", "claude.com", "platform.claude.com", "console.anthropic.com"] : ["auth.openai.com"];
    if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.includes(url.hostname)) return null;
    if (provider === "claude" && (url.pathname !== (url.hostname === "claude.com" ? "/cai/oauth/authorize" : "/oauth/authorize") || !url.searchParams.get("state") || !url.searchParams.get("code_challenge"))) return null;
    if (provider === "codex" && url.pathname !== (mode === "device" ? "/codex/device" : "/oauth/authorize")) return null;
    return url.toString();
  } catch { return null; }
}

export class LoginSessions {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  constructor(private readonly dependencies: LoginDependencies) {}
  async start(account: StoredAccount, registry: Registry, root: string, sessionId: string, mode: "device" | "browser" = "device", beforeLaunch?: () => Promise<void>): Promise<LoginSession> {
    if (this.disposed) throw new Error("Account sign-in is shutting down. Try again shortly.");
    if (account.source !== "managed") throw new Error("Add a separate account for isolated sign-in.");
    const command = accountCommand(registry, account.provider);
    await assertManagedCommand(account.provider, command.slice(1));
    if (!(await lstat(account.home)).isDirectory() || await realpath(account.home) !== join(await realpath(root), "accounts", account.id, account.provider)) throw new Error("The isolated account profile is missing or redirected.");
    await prepareProfile({ provider: account.provider, home: account.home, sourceHome: registry.sourceHomes[account.provider], sourceEnvironment: registry.sourceEnvironment[account.provider] });
    const cwd = join(root, "login", account.id); await mkdir(cwd, { recursive: true, mode: 0o700 });
    if (this.disposed) throw new Error("Account sign-in is shutting down. Try again shortly.");
    const duration = Math.min(this.dependencies.timeoutMs ?? 15 * 60_000, 15 * 60_000);
    const entry: Entry = { value: { id: sessionId, accountId: account.id, provider: account.provider,
      mode: account.provider === "claude" ? "browser" : mode, status: "starting", authorizationUrl: null,
      userCode: null, canSubmitCode: false, error: null, expiresAt: new Date(Date.now() + duration).toISOString() },
      buffer: "", nativeSuccess: false, stopped: false, pendingCompletions: [] };
    this.entries.set(account.id, entry);
    const env = { ...accountEnvironment(account, registry), BROWSER: "/usr/bin/true", NO_COLOR: "1", TERM: "dumb" };
    try {
      entry.process = (this.dependencies.createProcess ?? createLoginProcess)({ command,
        args: account.provider === "claude" ? ["auth", "login", "--claudeai"] : ["app-server", "--stdio"], env, cwd,
        receiptPath: join(root, "logins", `${account.id}.json`), loginToken: sessionId,
        onData: (stream, data) => this.receive(entry, stream, data),
        onExit: (code, receiptWritten) => {
          entry.stopped = true; clearTimeout(entry.timer); clearDetails(entry.value); entry.buffer = ""; entry.pendingCompletions = [];
          const successful = code === 0 && (account.provider === "claude" || entry.nativeSuccess);
          entry.finishing = (async () => {
            if (receiptWritten) {
              entry.value.status = "verifying";
              const ready = await this.dependencies.finish(account.id, sessionId, successful);
              if (successful && ready) { entry.value.status = "complete"; entry.value.error = null; return; }
            }
            entry.value.status = "error";
            entry.value.error ??= receiptWritten ? "Sign-in was not completed. Start sign-in again." : "Sign-in stopped unexpectedly. Wait a moment, then cancel this attempt before trying again.";
          })().catch(() => { entry.value.status = "error"; entry.value.error = "Could not verify sign-in. Check the account and try again."; });
        },
      });
      // Establish the crash watchdog before persisting a login reservation. The
      // native CLI cannot start until that reservation has been committed.
      await entry.process.ready();
      await beforeLaunch?.();
      if (entry.stopped || this.disposed) throw new Error("Sign-in stopped before launch.");
      entry.process.start();
      entry.timer = setTimeout(() => { void this.fail(entry, "Sign-in expired. Start sign-in again."); }, duration);
      entry.timer.unref();
      if (account.provider === "codex") entry.process.write(JSON.stringify({ id: 1, method: "initialize", params: {
        clientInfo: { name: "paseo_account_switcher", title: "Paseo Account Switcher", version: "0.1.0" }, capabilities: null,
      } }) + "\n");
      return structuredClone(entry.value);
    } catch {
      clearTimeout(entry.timer);
      if (entry.process) await entry.process.stop();
      this.entries.delete(account.id);
      throw new Error("Could not start account sign-in. Check the provider CLI and try again.");
    }
  }
  private receive(entry: Entry, stream: "stdout" | "stderr", data: string) {
    if (entry.stopped || entry.value.status === "error" || stream !== "stdout") return;
    if (entry.buffer.length + data.length > 128 * 1024) { void this.fail(entry, "The provider returned an unsupported sign-in response. Update the CLI and try again."); return; }
    entry.buffer += data;
    if (entry.value.provider === "claude") {
      // The official CLI prints its manual-redirect URL; keep only this URL.
      const plain = entry.buffer.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      for (const candidate of plain.match(/https:\/\/[^\s<>\x1b]+(?=[\s<>\x1b])/g) ?? []) {
        const url = loginUrl(candidate, "claude");
        if (url && entry.value.status === "starting") { entry.value.authorizationUrl = url; entry.value.canSubmitCode = true; entry.value.status = "waiting"; }
      }
      return;
    }
    let newline: number;
    while ((newline = entry.buffer.indexOf("\n")) !== -1) {
      const line = entry.buffer.slice(0, newline); entry.buffer = entry.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line); if (!message || typeof message !== "object") throw new Error(); }
      catch { void this.fail(entry, "The provider returned an unsupported sign-in response. Update Codex and try again."); return; }
      if (message.id === 1) {
        if (message.error || !message.result) { void this.fail(entry, "Could not initialize Codex sign-in. Update Codex and try again."); return; }
        entry.process?.write(JSON.stringify({ method: "initialized" }) + "\n");
        entry.process?.write(JSON.stringify({ id: 2, method: "account/login/start", params: { type: entry.value.mode === "device" ? "chatgptDeviceCode" : "chatgpt" } }) + "\n");
      } else if (message.id === 2) {
        const result = message.result as Record<string, unknown> | undefined;
        const expected = entry.value.mode === "device" ? "chatgptDeviceCode" : "chatgpt";
        const url = loginUrl(expected === "chatgptDeviceCode" ? result?.verificationUrl : result?.authUrl, "codex", entry.value.mode);
        if (message.error || result?.type !== expected || typeof result.loginId !== "string" || !result.loginId || !url || expected === "chatgptDeviceCode" && (typeof result.userCode !== "string" || !/^[A-Za-z0-9-]{3,64}$/.test(result.userCode))) {
          void this.fail(entry, entry.value.mode === "device" ? "Device sign-in is unavailable. Enable device code login in ChatGPT security settings, or use browser sign-in on the daemon host." : "Could not start browser sign-in. Try device sign-in or check the provider CLI."); return;
        }
        entry.nativeLoginId = result.loginId; entry.value.authorizationUrl = url;
        entry.value.userCode = expected === "chatgptDeviceCode" ? result.userCode as string : null; entry.value.status = "waiting";
        for (const pending of entry.pendingCompletions.splice(0)) this.completed(entry, pending);
      } else if (message.method === "account/login/completed") {
        const params = message.params as Record<string, unknown> | undefined;
        if (!params || typeof params.loginId !== "string") continue;
        if (entry.nativeLoginId) this.completed(entry, params);
        else if (entry.pendingCompletions.length < 8) entry.pendingCompletions.push({loginId:params.loginId,success:params.success});
      }
    }
  }
  private completed(entry: Entry, params: Record<string, unknown>) {
    if (entry.stopped || entry.value.status === "verifying" || params.loginId !== entry.nativeLoginId) return;
    if (params.success !== true) { void this.fail(entry, "The provider did not complete sign-in. Start sign-in again."); return; }
    entry.nativeSuccess = true; entry.value.status = "verifying"; clearDetails(entry.value);
    void entry.process?.stop(0).catch(() => { entry.value.status = "error"; entry.value.error = "Could not confirm that sign-in finished. Try checking again shortly."; });
  }
  private async fail(entry: Entry, message: string) {
    entry.value.status = "error"; entry.value.error = message; clearDetails(entry.value); entry.buffer = ""; entry.pendingCompletions = []; clearTimeout(entry.timer);
    try { await entry.process?.stop(); } catch { entry.value.error = "Could not confirm that sign-in stopped. Try canceling again shortly."; }
  }
  has(accountId: string, sessionId: string): boolean { return this.entries.get(accountId)?.value.id === sessionId; }
  status(accountId: string, sessionId: string): LoginSession {
    const entry = this.entries.get(accountId); if (!entry || entry.value.id !== sessionId) throw stale();
    return structuredClone(entry.value);
  }
  submit(accountId: string, sessionId: string, input: string): LoginSession {
    const entry = this.entries.get(accountId); if (!entry || entry.value.id !== sessionId) throw stale();
    if (!entry.value.canSubmitCode || entry.value.status !== "waiting" || !entry.value.authorizationUrl || entry.stopped) throw new Error("This sign-in attempt is not waiting for a code.");
    const code = input.trim();
    if (code.length > 2048 || !/^[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/.test(code) || code.split("#")[1] !== new URL(entry.value.authorizationUrl).searchParams.get("state")) throw new Error("Use the complete sign-in code from this attempt, including the part after #.");
    entry.value.status = "verifying"; entry.value.canSubmitCode = false;
    entry.process?.write(code + "\n");
    return structuredClone(entry.value);
  }
  async cancel(accountId: string, sessionId: string): Promise<void> {
    const entry = this.entries.get(accountId); if (!entry || entry.value.id !== sessionId) throw stale();
    entry.value.error = "Sign-in canceled."; clearDetails(entry.value); entry.buffer = ""; entry.pendingCompletions = []; clearTimeout(entry.timer);
    if (!entry.stopped && entry.nativeLoginId) entry.process?.write(JSON.stringify({ id: 3, method: "account/login/cancel", params: { loginId: entry.nativeLoginId } }) + "\n");
    await entry.process?.stop(); await entry.finishing;
    entry.value.status = "error"; clearDetails(entry.value);
  }
  async close(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.entries].map(([id, entry]) => this.cancel(id, entry.value.id)));
  }
}
