import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { UsageSnapshotSchema, type Provider, type UsageSnapshot, type UsageWindow } from "../../shared/contracts";
import { collectClaudeUsage } from "./claude";
import { collectCodexUsage } from "./codex";
import { object } from "./parsers";

export type QuotaAccount = { id: string; provider: Provider; home: string; command: string[]; env: NodeJS.ProcessEnv; identityKey: string | null; generation: number; credentialVersion?: string; identityCredentialVersion?: string; requireIdentityVerification?: boolean };
export { readCredentialVersion } from "./credentials";
export type CollectedUsage = { identityKey: string | null; plan: string | null; windows: UsageWindow[] };
export type FetchUsage = (account: QuotaAccount, signal?: AbortSignal) => Promise<CollectedUsage>;
export type AccountReadOptions = { verifyAccountId?: string };
export type UsageOptions = { getAccounts: (input?: AccountReadOptions) => Promise<QuotaAccount[]>; fetchUsage?: FetchUsage; cachePath?: string; now?: () => number };
export class UsageError extends Error {
  constructor(public readonly status: "needs_auth" | "unavailable", public readonly code: string, public readonly retryAfterMs?: number) {
    super(status === "needs_auth" ? "Sign in again to retrieve limits." : "The limits service is temporarily unavailable.");
  }
}
type Entry = { fingerprint: string; accountFingerprint: string; provenIdentity: boolean; snapshot: UsageSnapshot; success?: UsageSnapshot; attempts: number; attemptedAt: number | null; retryAt: number };
type Flight = { entry: Entry; promise: Promise<void>; controller: AbortController };
const BACKGROUND = 300000;
const VISIBLE = 60000;
const LEASE = 90000;
const MAX_BACKOFF = 1800000;

function fingerprint(account: QuotaAccount, includeCredentials=true): string {
  return createHash("sha256").update(JSON.stringify([account.provider, account.home, account.identityKey, account.generation, account.command, includeCredentials?account.credentialVersion:undefined])).digest("hex");
}
const identityProven = (account:QuotaAccount) => account.identityKey!==null&&!!account.credentialVersion?.startsWith("present:")&&account.credentialVersion===account.identityCredentialVersion;
const fetchProvider: FetchUsage = (account, signal) => account.provider === "codex" ? collectCodexUsage(account, signal) : collectClaudeUsage(account, {}, signal);

export function createUsageService(options: UsageOptions) {
  const entries = new Map<string, Entry>();
  const flights = new Map<string, Flight>();
  const invalidated = new Set<string>();
  const cached = new Map<string, {fingerprint: string; accountFingerprint?: string; snapshot: UsageSnapshot}>();
  const now = options.now ?? Date.now;
  const fetchUsage = options.fetchUsage ?? fetchProvider;
  let visibleUntil = -1;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let running = 0;
  const queue: (() => void)[] = [];
  let writes: Promise<void> = Promise.resolve();
  const initialized = (async () => {
    if (!options.cachePath) return;
    try {
      const raw = await readFile(options.cachePath,"utf8");
      if (raw.length > 4 * 1024 * 1024) return;
      const rows = object(JSON.parse(raw))?.entries;
      if (!Array.isArray(rows)) return;
      for (const value of rows) {
        const row = object(value);
        const parsed = UsageSnapshotSchema.safeParse(row?.snapshot);
        if (parsed.success && parsed.data.status === "ok" && parsed.data.fetchedAt && typeof row?.fingerprint === "string") cached.set(parsed.data.accountId,{fingerprint:row.fingerprint,accountFingerprint:typeof row.accountFingerprint==="string"?row.accountFingerprint:undefined,snapshot:parsed.data});
      }
    } catch { /* A missing or corrupt optional cache never blocks quota reads. */ }
  })();
  function persist(): Promise<void> {
    if (!options.cachePath) return Promise.resolve();
    const path = options.cachePath;
    writes = writes.then(async () => {
      const rows = [...cached.values(),...[...entries.values()].flatMap(entry=>entry.success?[{fingerprint:entry.fingerprint,accountFingerprint:entry.accountFingerprint,snapshot:entry.success}]:[])];
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(path),{recursive:true,mode:0o700});
        await writeFile(temporary,JSON.stringify({version:1,entries:rows}),{mode:0o600,flag:"wx"});
        await rename(temporary,path);
      } finally { await rm(temporary,{force:true}).catch(()=>{}); }
    }).catch(()=>{});
    return writes;
  }
  function empty(account: QuotaAccount): UsageSnapshot {
    return {accountId:account.id,provider:account.provider,status:"unavailable",plan:null,windows:[],fetchedAt:null,checkedAt:new Date(now()).toISOString(),nextRetryAt:null,error:null};
  }
  async function sync(input?: AccountReadOptions): Promise<QuotaAccount[]> {
    await initialized;
    if(closed)return [];
    let accounts: QuotaAccount[];
    try {accounts = await options.getAccounts(input);} catch {throw new UsageError("unavailable","account_discovery_failed");}
    if(closed)return [];
    const ids = new Set(accounts.map(account=>account.id));
    let changed = false;
    for(const id of cached.keys())if(!ids.has(id)){cached.delete(id);changed=true;}
    for (const id of entries.keys()) if (!ids.has(id)) { entries.delete(id); cached.delete(id); flights.get(id)?.controller.abort(); changed=true; }
    for (const account of accounts) {
      const signature = fingerprint(account);
      const previous=entries.get(account.id);
      const provenIdentity=identityProven(account);
      const accountFingerprint=fingerprint(account,false);
      const prior=cached.get(account.id);
      const canRestore=account.identityKey!==null&&!invalidated.has(account.id)&&(!account.requireIdentityVerification||provenIdentity);
      const success=canRestore&&(prior?.fingerprint===signature||provenIdentity&&prior?.accountFingerprint===accountFingerprint)?prior!.snapshot:undefined;
      // Cold controller snapshots intentionally have no credential proof yet.
      // Keep their disk cache staged without making it visible or overwriting it.
      if(account.identityKey===null||invalidated.has(account.id)||canRestore){if(cached.delete(account.id))changed=true;}
      if (previous?.fingerprint === signature) {
        previous.provenIdentity||=provenIdentity;
        if(success&&!previous.success){previous.success=success;previous.snapshot={...success,status:"stale",error:"Saved limits; waiting for an update."};changed=true;}
        continue;
      }
      const sameAccount=previous?.accountFingerprint===accountFingerprint;
      if(previous&&sameAccount&&previous.provenIdentity&&provenIdentity){
        previous.fingerprint=signature;
        if(previous.snapshot.status==="ok")previous.snapshot={...previous.snapshot,status:"stale",error:"Credentials changed; waiting to verify limits."};
        cached.delete(account.id);changed=true;continue;
      }
      const snapshot = success ? {...success,status:"stale" as const,error:"Saved limits; waiting for an update."} : empty(account);
      entries.set(account.id,{fingerprint:signature,accountFingerprint,provenIdentity,snapshot,success,attempts:sameAccount?previous.attempts:0,attemptedAt:sameAccount?previous.attemptedAt:null,retryAt:sameAccount?previous.retryAt:0});
      changed=true;
    }
    if (changed && options.cachePath) void persist();
    return accounts;
  }
  async function acquire() {
    if (running < 2) {running++;return;}
    await new Promise<void>(resolve=>queue.push(resolve));
  }
  function release() {const next=queue.shift();if(next)next();else running--;}
  async function refreshOne(account: QuotaAccount): Promise<void> {
    let entry = entries.get(account.id);
    if (closed || !entry || fingerprint(account) !== entry.fingerprint || now() < entry.retryAt) return;
    const inFlight = flights.get(account.id);
    if (inFlight) {
      await inFlight.promise;
      if (inFlight.entry !== entry && !closed) {
        const current = (await sync()).find(value=>value.id===account.id);
        if(current)return refreshOne(current);
      }
      return;
    }
    const controller = new AbortController();
    const promise = (async () => {
      await acquire();
      try {
        if (closed || entries.get(account.id) !== entry) return;
        entry.attemptedAt = now();
        let result: CollectedUsage | undefined;
        let failure: UsageError | undefined;
        let requested=false;
        try {
          const verified=(await sync({verifyAccountId:account.id})).find(value=>value.id===account.id);
          if(!verified||closed||controller.signal.aborted)return;
          entry=entries.get(account.id);
          if(!entry)return;
          const flight=flights.get(account.id);if(flight)flight.entry=entry;
          entry.attemptedAt=now();
          account=verified;
          if(account.requireIdentityVerification&&!identityProven(account))throw new UsageError(account.credentialVersion==="absent"?"needs_auth":"unavailable","identity_unverified");
          requested=true;
          result = await fetchUsage(account,controller.signal);
          if (account.identityKey && result.identityKey && account.identityKey !== result.identityKey) throw new UsageError("needs_auth","identity_changed");
        } catch (error) {failure=error instanceof UsageError?error:new UsageError("unavailable","request_failed");}
        let current:QuotaAccount[]|undefined;
        try {current=await sync(requested?{verifyAccountId:account.id}:undefined);}
        catch {failure??=new UsageError("unavailable","account_discovery_failed");}
        if (closed || !entry || current&&!current.some(a=>a.id===account.id) || entries.get(account.id) !== entry) return;
        const verified=current?.find(a=>a.id===account.id)??account;
        if(requested&&verified.requireIdentityVerification&&!identityProven(verified))failure??=new UsageError(verified.credentialVersion==="absent"?"needs_auth":"unavailable","identity_unverified");
        if(requested&&account.credentialVersion!==verified.credentialVersion&&(!identityProven(account)||!identityProven(verified)||result?.identityKey!==account.identityKey))failure??=new UsageError("unavailable","response_identity_unverified");
        const checkedAt = new Date(now()).toISOString();
        if (result && !failure) {
          const snapshot: UsageSnapshot = {accountId:account.id,provider:account.provider,status:"ok",plan:result.plan,windows:result.windows,fetchedAt:checkedAt,checkedAt,nextRetryAt:null,error:null};
          entry.snapshot=snapshot;entry.success=account.identityKey===null?undefined:snapshot;entry.attempts=0;entry.retryAt=0;
        } else {
          const error=failure??new UsageError("unavailable","request_failed");
          entry.attempts++;
          const backoff = error.retryAfterMs !== undefined && Number.isFinite(error.retryAfterMs) ? Math.max(0,error.retryAfterMs) : Math.min(MAX_BACKOFF,60000*2**Math.min(entry.attempts-1,5));
          entry.retryAt=now()+backoff;
          if (error.status==="needs_auth") entry.success=undefined;
          const previous=entry.success;
          entry.snapshot={accountId:account.id,provider:account.provider,status:error.status==="needs_auth"?"needs_auth":previous?"stale":"unavailable",plan:previous?.plan??null,windows:previous?.windows??[],fetchedAt:previous?.fetchedAt??null,checkedAt,nextRetryAt:new Date(entry.retryAt).toISOString(),error:error.message};
        }
        await persist();
      } finally { release(); }
    })();
    flights.set(account.id,{entry,promise,controller});
    try {await promise;} finally {if(flights.get(account.id)?.promise===promise)flights.delete(account.id);}
  }
  const snapshots = (accounts: QuotaAccount[]) => accounts.map(a=>structuredClone(entries.get(a.id)?.snapshot??empty(a)));
  async function refresh(accountId?: string): Promise<UsageSnapshot[]> {
    const accounts=await sync();
    await Promise.all(accounts.filter(account=>!accountId||account.id===accountId).map(refreshOne));
    return snapshots(await sync());
  }
  async function tick(): Promise<void> {
    if(closed)return;
    const accounts=await sync();
    const cadence=now()<visibleUntil?VISIBLE:BACKGROUND;
    await Promise.all(accounts.filter(account=>{
      const entry=entries.get(account.id)!;
      if(entry.attemptedAt===null||now()-entry.attemptedAt>=cadence)return true;
      return entry.snapshot.windows.some(window=>{
        const reset=window.resetsAt?Date.parse(window.resetsAt):NaN;
        return Number.isFinite(reset)&&reset<=now()&&reset>entry.attemptedAt!;
      });
    }).map(refreshOne));
  }
  async function list(input: {visible?:boolean} = {}): Promise<UsageSnapshot[]> {
    if(input.visible)visibleUntil=now()+LEASE;
    const accounts=await sync();
    if(timer)void tick().catch(()=>{});
    return snapshots(accounts);
  }
  function start() {
    if(timer||closed)return;
    timer=setInterval(()=>{void tick().catch(()=>{});},5000);
    timer.unref();
    void tick().catch(()=>{});
  }
  function invalidate(accountId: string) {
    if(closed)return;
    invalidated.add(accountId);cached.delete(accountId);entries.delete(accountId);flights.get(accountId)?.controller.abort();void persist();
  }
  async function close() {
    closed=true;
    if(timer)clearInterval(timer);
    timer=undefined;
    for(const flight of flights.values())flight.controller.abort();
    await Promise.allSettled([...flights.values()].map(flight=>flight.promise));
    await writes;
  }
  return {list,refresh,start,close,invalidate};
}
