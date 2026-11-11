import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { UsageError, type CollectedUsage, type QuotaAccount } from "./index";
import { retryAfter, type ClaudeDependencies } from "./claude";
import { credentialHash } from "./credential-hash";
import { object, string } from "./parsers";
import { cursorCredentialFile } from "../profiles";

// Cursor's built-in Paseo usage source uses the same endpoint and fields.
export async function readCursorCredentials(account: QuotaAccount, dependencies: ClaudeDependencies = {}, signal?: AbortSignal): Promise<{raw:string;source:string}> {
  const macSystem = (dependencies.platform ?? process.platform) === "darwin" && account.source === "system";
  if (macSystem && account.env.AGENT_CLI_CREDENTIAL_STORE !== "file") {
    if (account.env.AGENT_CLI_CREDENTIAL_STORE === "memory") throw new UsageError("needs_auth", "missing_credentials");
    const read = dependencies.readKeychain ?? ((target, signal) => new Promise<string | null>((resolve, reject) => {
      execFile("/usr/bin/security", ["find-generic-password", "-a", target.account, "-s", target.service, "-w"], {timeout: 3000, maxBuffer: 256 * 1024, signal}, (error, stdout) => {
        if (!error) resolve(stdout.trim() || null);
        else if ((error as {code?: number | string}).code === 44) resolve(null);
        else reject(new UsageError("unavailable", "keychain_unavailable"));
      });
    }));
    const token = await read({account:"cursor-user",service:"cursor-access-token"}, signal);
    if (!token) throw new UsageError("needs_auth", "missing_credentials");
    return {source:"keychain",raw:JSON.stringify({accessToken:token})};
  }
  const path = macSystem ? join(account.home, ".cursor", "auth.json") : account.source === "managed" ? await cursorCredentialFile(account.home) : join(account.home, "cursor", "auth.json");
  return {source:"file",raw:await (dependencies.readFile ?? (path => readFile(path, "utf8")))(path)};
}

const number = (value: unknown): number | null => {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
function timestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value), ms = Number.isFinite(n) ? (Math.abs(n) < 10_000_000_000 ? n * 1000 : n) : Date.parse(String(value));
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}

export async function collectCursorUsage(account: QuotaAccount, signal?: AbortSignal): Promise<CollectedUsage> {
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 15_000); timeout.unref();
  try {
    const {raw,source} = await readCursorCredentials(account, {}, signal);
    if (account.requireIdentityVerification && credentialHash(source, raw) !== account.identityCredentialVersion) throw new UsageError("unavailable", "credentials_changed");
    let auth: unknown;
    try { auth = JSON.parse(raw); } catch { throw new UsageError("needs_auth", "invalid_credentials"); }
    const token = string(object(auth)?.accessToken);
    if (!token) throw new UsageError("needs_auth", "missing_oauth");
    const response = await fetch("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" }, body: "{}",
      signal: controller.signal, redirect: "error",
    });
    if (response.status === 401) throw new UsageError("needs_auth", "unauthorized");
    if (response.status === 429) throw new UsageError("unavailable", "rate_limited", retryAfter(response.headers.get("retry-after"), Date.now()));
    if (!response.ok) throw new UsageError("unavailable", "http_error");
    const data = object(await response.json()), plan = object(data?.planUsage), resetsAt = timestamp(data?.billingCycleEnd);
    const windows: CollectedUsage["windows"] = [];
    for (const [id, label, field] of [["plan_usage", "Total", "totalPercentUsed"], ["cursor_usage", "Cursor", "autoPercentUsed"], ["third_party_usage", "Third Party", "apiPercentUsed"]] as const) {
      const usedPercent = number(plan?.[field]);
      if (usedPercent !== null) windows.push({ id, label, usedPercent, windowDurationMins: null, resetsAt });
    }
    // As in Paseo, use the reported plan balance only when no percentages are present.
    if (plan && !windows.length) {
      const used = number(plan.totalSpend), remaining = number(plan.remaining), limit = number(plan.limit);
      const detail = [["used", used], ["remaining", remaining], ["limit", limit]].flatMap(([label, amount]) => typeof amount === "number" ? [`$${(amount / 100).toFixed(2)} ${label}`] : []).join(" · ");
      if (detail) windows.push({ id: "plan_usage", label: "Plan usage", usedPercent: used !== null && limit ? used / limit * 100 : null, windowDurationMins: null, resetsAt, detail });
    }
    if (!windows.length) throw new UsageError("unavailable", "invalid_payload");
    // The response has no account identity; a credential rotation during this request must be rechecked.
    return { identityKey: null, plan: null, windows };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "")) throw new UsageError("needs_auth", "missing_credentials");
    throw new UsageError("unavailable", "request_failed");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
