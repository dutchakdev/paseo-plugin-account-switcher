import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { UsageError, type CollectedUsage, type QuotaAccount } from "./index";
import { object, parseClaudeUsage, string } from "./parsers";
import { credentialHash } from "./credential-hash";

type KeychainTarget = { service: string; account: string };
export type ClaudeDependencies = {
  platform?: string;
  readFile?: (path: string) => Promise<string>;
  readKeychain?: (target: KeychainTarget, signal?: AbortSignal) => Promise<string | null>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
};
export function claudeKeychainTarget(account: QuotaAccount): KeychainTarget {
  const custom = account.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? account.env.CLAUDE_CONFIG_DIR;
  // Verified against Claude Code 2.1.263's embedded secure-storage implementation.
  const resolvedHome = custom || join(account.env.HOME || homedir(),".claude");
  if (resolvedHome.normalize("NFC") !== account.home.normalize("NFC")) throw new UsageError("unavailable", "home_mismatch");
  const suffix = custom ? `-${createHash("sha256").update(account.home.normalize("NFC")).digest("hex").slice(0,8)}` : "";
  const user = account.env.USER;
  return { service: `Claude Code-credentials${suffix}`, account: user && /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user" };
}
/** Internal resolver shared by collection and credential-version checks. */
export async function readClaudeCredentials(account: QuotaAccount, dependencies: ClaudeDependencies = {}, signal?: AbortSignal): Promise<{raw:string;source:string}> {
  const target = claudeKeychainTarget(account);
  let keychainUnavailable=false;
  if ((dependencies.platform ?? process.platform) === "darwin") {
    let raw:string|null=null;
    try {raw = await (dependencies.readKeychain ?? keychain)(target, signal);}
    catch {keychainUnavailable=true;}
    if(signal?.aborted)throw new UsageError("unavailable","cancelled");
    if(raw) {
      try {if(JSON.parse(raw)!==null)return {raw,source:"keychain"};} catch { /* Native CLI falls back for corrupt Keychain JSON. */ }
    }
  }
  try {return {raw:await (dependencies.readFile ?? (p=>readFile(p,"utf8")))(join(account.home,".credentials.json")),source:"file"};}
  catch(error) {
    const missing=["ENOENT","ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code??"");
    throw new UsageError(missing&&!keychainUnavailable?"needs_auth":"unavailable",missing&&!keychainUnavailable?"missing_credentials":"credential_read_failed");
  }
}
function keychain(target: KeychainTarget, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/security", ["find-generic-password", "-a", target.account, "-w", "-s", target.service], { timeout: 3000, maxBuffer: 1024 * 1024, signal }, (error, stdout) => {
      if (!error) resolve(stdout.trim() || null);
      else if ((error as {code?: number | string}).code === 44) resolve(null);
      else reject(new UsageError("unavailable", "keychain_unavailable"));
    });
  });
}
export function retryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
export async function collectClaudeUsage(account: QuotaAccount, dependencies: ClaudeDependencies = {}, signal?: AbortSignal): Promise<CollectedUsage> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, {once:true});
  const timeout = setTimeout(abort,15000);
  timeout.unref();
  try {
    const resolved=await readClaudeCredentials(account,dependencies,signal);
    if(account.requireIdentityVerification&&credentialHash(resolved.source,resolved.raw)!==account.identityCredentialVersion)throw new UsageError("unavailable","credentials_changed");
    let stored:unknown;
    try {stored=JSON.parse(resolved.raw);} catch {throw new UsageError("needs_auth","invalid_credentials");}
    const oauth = object(object(stored)?.claudeAiOauth);
    const token = string(oauth?.accessToken);
    if (!token) throw new UsageError("needs_auth", "missing_oauth");
    const response = await (dependencies.fetch ?? fetch)("https://api.anthropic.com/api/oauth/usage", {
      method: "GET", headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
    });
    if (response.status === 401) throw new UsageError("needs_auth", "unauthorized");
    if (response.status === 429) throw new UsageError("unavailable", "rate_limited", retryAfter(response.headers.get("retry-after"), (dependencies.now ?? Date.now)()));
    if (!response.ok) throw new UsageError("unavailable", response.status === 403 ? "forbidden" : "http_error");
    const result = parseClaudeUsage(await response.json());
    if (!result.windows.length) throw new UsageError("unavailable", "invalid_payload");
    return { ...result, identityKey: account.identityKey, plan: string(oauth?.subscriptionType) };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError("unavailable", "request_failed");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort",abort);
  }
}
