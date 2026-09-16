import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUsageService, UsageError, type QuotaAccount } from "../server/usage/index";

const account: QuotaAccount = { id: "a", provider: "codex", home: "/isolated/a", command: ["codex"], env: {}, identityKey: "identity-a", generation: 1 };
const result = { identityKey: "identity-a", plan: "plus", windows: [{ id: "codex:primary", label: "Codex", usedPercent: 0, windowDurationMins: 300, resetsAt: "2026-09-16T00:00:00.000Z" }] };

describe("usage service", () => {
  it("preserves successful quota data as stale after a transient error", async () => {
    let failing = false;
    const service = createUsageService({ getAccounts: async () => [account], fetchUsage: async () => {
      if (failing) throw new UsageError("unavailable", "network");
      return result;
    } });
    expect((await service.refresh())[0]).toMatchObject({ status: "ok", windows: result.windows });
    failing = true;
    expect((await service.refresh())[0]).toMatchObject({ status: "stale", windows: result.windows, error: "The limits service is temporarily unavailable." });
    await service.close();
  });
  it("discards an in-flight response when the account identity changes", async () => {
    let current = { ...account };
    let release!: (value: typeof result) => void;
    const service = createUsageService({ getAccounts: async () => [current], fetchUsage: () => new Promise(resolve => { release = resolve; }) });
    const request = service.refresh();
    await new Promise(resolve => setImmediate(resolve));
    current = { ...account, identityKey: "identity-b", generation: 2 };
    release(result);
    const snapshots = await request;
    expect(snapshots[0]?.windows ?? []).toEqual([]);
    await service.close();
  });
  it("honors provider backoff even for manual refresh and clears stale quotas on auth loss", async () => {
    let now = 0;
    let error: UsageError | null = null;
    const fetchUsage = vi.fn(async () => {if (error) throw error; return result;});
    const service = createUsageService({getAccounts:async()=>[account],fetchUsage,now:()=>now});
    await service.refresh();
    error = new UsageError("unavailable","rate_limited",600000);
    await service.refresh();
    const delayed = await service.refresh();
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(delayed[0]).toMatchObject({status:"stale",nextRetryAt:"1970-01-01T00:10:00.000Z"});
    now = 600000;
    error = new UsageError("needs_auth","missing");
    expect((await service.refresh())[0]).toMatchObject({status:"needs_auth",windows:[],fetchedAt:null});
    await service.close();
  });
  it("shares in-flight work for an account and runs at most two collectors", async () => {
    const accounts = [account,{...account,id:"b"},{...account,id:"c"}];
    let active = 0; let peak = 0;
    const releases: (() => void)[] = [];
    const fetchUsage = vi.fn(async () => {active++;peak=Math.max(peak,active);await new Promise<void>(resolve=>releases.push(resolve));active--;return result;});
    const service = createUsageService({getAccounts:async()=>accounts,fetchUsage});
    const first = service.refresh(); const second = service.refresh();
    await new Promise(resolve=>setImmediate(resolve));
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    releases.splice(0).forEach(release=>release());
    await new Promise(resolve=>setImmediate(resolve));
    releases.splice(0).forEach(release=>release());
    await Promise.all([first,second]);
    expect(fetchUsage).toHaveBeenCalledTimes(3);
    expect(peak).toBe(2);
    await service.close();
  });
  it("shares the two-worker limit across before probes, requests and after probes",async()=>{
    const accounts=[account,{...account,id:"b"},{...account,id:"c"},{...account,id:"d"}];
    let active=0,peak=0,verified=0;
    const releases:(()=>void)[]=[];
    const operation=async()=>{active++;peak=Math.max(peak,active);await new Promise<void>(resolve=>releases.push(resolve));active--;};
    const fetchUsage=vi.fn(async()=>{await operation();return result;});
    const service=createUsageService({getAccounts:async input=>{if(input?.verifyAccountId){verified++;await operation();}return accounts;},fetchUsage});
    try {
      const request=service.refresh(),sameRequest=service.refresh();
      for(let stage=0;stage<6;stage++){
        await new Promise(resolve=>setImmediate(resolve));
        expect(active).toBe(2);releases.splice(0).forEach(release=>release());
      }
      await Promise.all([request,sameRequest]);
      expect(peak).toBe(2);expect(verified).toBe(8);expect(fetchUsage).toHaveBeenCalledTimes(4);
    } finally {releases.splice(0).forEach(release=>release());await service.close();}
  });
  it("polls all accounts at five minutes and uses a ninety-second visible lease", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const fetchUsage=vi.fn(async()=>result);
    const service=createUsageService({getAccounts:async()=>[account],fetchUsage});
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchUsage).toHaveBeenCalledTimes(1);
      await service.list({visible:true});
      await vi.advanceTimersByTimeAsync(60000);
      expect(fetchUsage).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(90000);
      expect(fetchUsage).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(210000);
      expect(fetchUsage).toHaveBeenCalledTimes(3);
    } finally {await service.close();vi.useRealTimers();}
  });
  it("verifies credentials only around scheduled requests, including visible and reset refreshes",async()=>{
    vi.useFakeTimers();vi.setSystemTime(0);
    const verifications:number[]=[];
    const fetchUsage=vi.fn(async()=>({...result,windows:[{...result.windows[0]!,resetsAt:new Date(325000).toISOString()}]}));
    const service=createUsageService({getAccounts:async input=>{
      if(input?.verifyAccountId)verifications.push(Date.now());
      return [account];
    },fetchUsage});
    try {
      service.start();await vi.advanceTimersByTimeAsync(0);
      expect(verifications).toEqual([0,0]);
      for(let tick=0;tick<59;tick++){await service.list();await vi.advanceTimersByTimeAsync(5000);}
      expect(verifications).toEqual([0,0]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(verifications).toEqual([0,0,300000,300000]);
      await vi.advanceTimersByTimeAsync(25000);
      expect(verifications.slice(-2)).toEqual([325000,325000]);
      await service.list({visible:true});await vi.advanceTimersByTimeAsync(60000);
      expect(verifications.slice(-2)).toEqual([385000,385000]);
      expect(fetchUsage).toHaveBeenCalledTimes(4);
    } finally {await service.close();vi.useRealTimers();}
  });
  it("restores only matching-identity last-success cache with private file permissions", async () => {
    const directory=await mkdtemp(join(tmpdir(),"paseo-usage-test-"));
    const cachePath=join(directory,"usage.json");
    try {
      const service=createUsageService({getAccounts:async()=>[account],fetchUsage:async()=>result,cachePath});
      await service.refresh(); await service.close();
      expect((await stat(cachePath)).mode&0o777).toBe(0o600);
      expect(await readFile(cachePath,"utf8")).not.toContain("identity-a");
      const restored=createUsageService({getAccounts:async()=>[account],fetchUsage:async()=>result,cachePath});
      expect((await restored.list())[0]).toMatchObject({status:"stale",windows:result.windows});
      await restored.close();
      const different=createUsageService({getAccounts:async()=>[{...account,identityKey:"different"}],fetchUsage:async()=>result,cachePath});
      expect((await different.list())[0]?.windows).toEqual([]);
      await different.close();
    } finally {await rm(directory,{recursive:true,force:true});}
  });
  it("invalidation discards a completed old response and allows a fresh account read", async () => {
    let release!: (value: typeof result) => void;
    const fetchUsage=vi.fn(()=>new Promise<typeof result>(resolve=>{release=resolve;}));
    const service=createUsageService({getAccounts:async()=>[account],fetchUsage});
    const request=service.refresh();
    await new Promise(resolve=>setImmediate(resolve));
    service.invalidate(account.id);
    release(result);
    expect((await request)[0]?.windows).toEqual([]);
    fetchUsage.mockResolvedValue(result);
    expect((await service.refresh())[0]?.status).toBe("ok");
    await service.close();
  });
  it("caps exponential failure backoff at thirty minutes and sanitizes unknown errors", async () => {
    let now=0;
    const service=createUsageService({getAccounts:async()=>[account],now:()=>now,fetchUsage:async()=>{throw new Error("SECRET upstream token");}});
    const delays=[];
    for(let attempt=0;attempt<7;attempt++) {
      const snapshot=(await service.refresh())[0]!;
      const retry=Date.parse(snapshot.nextRetryAt!);
      delays.push(retry-now);now=retry;
      expect(snapshot.error).toBe("The limits service is temporarily unavailable.");
    }
    expect(delays).toEqual([60000,120000,240000,480000,960000,1800000,1800000]);
    await service.close();
  });
  it("fetches after a reported reset without inventing quota recovery or repeatedly polling it", async () => {
    vi.useFakeTimers();vi.setSystemTime(0);
    const afterReset={...result,windows:[{...result.windows[0]!,usedPercent:95,resetsAt:new Date(20000).toISOString()}]};
    const fetchUsage=vi.fn(async()=>afterReset);
    const service=createUsageService({getAccounts:async()=>[account],fetchUsage});
    try {
      service.start();await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20000);
      expect(fetchUsage).toHaveBeenCalledTimes(2);
      expect((await service.list())[0]?.windows[0]?.usedPercent).toBe(95);
      await vi.advanceTimersByTimeAsync(60000);
      expect(fetchUsage).toHaveBeenCalledTimes(2);
    } finally {await service.close();vi.useRealTimers();}
  });
  it("does not start collection after close while account discovery is in flight", async () => {
    let release!: (accounts:QuotaAccount[])=>void;
    const getAccounts=vi.fn(()=>new Promise<QuotaAccount[]>(resolve=>{release=resolve;}));
    const fetchUsage=vi.fn(async()=>result);
    const service=createUsageService({getAccounts,fetchUsage});
    const request=service.refresh();
    await new Promise(resolve=>setImmediate(resolve));
    await service.close();
    release([account]);
    expect(await request).toEqual([]);
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(getAccounts).toHaveBeenCalledTimes(1);
  });
  it("clears old quota data when an identity becomes absent", async () => {
    let current={...account};
    const service=createUsageService({getAccounts:async()=>[current],fetchUsage:async()=>result});
    await service.refresh();current={...account,identityKey:null};
    expect((await service.list())[0]).toMatchObject({windows:[],fetchedAt:null,plan:null});
    await service.close();
  });
  it("discards an in-flight response when exact profile credentials change", async () => {
    let current:QuotaAccount={...account,credentialVersion:"present:old"};
    let release!:(value:typeof result)=>void;
    const service=createUsageService({getAccounts:async()=>[current],fetchUsage:()=>new Promise(resolve=>{release=resolve;})});
    const request=service.refresh();await new Promise(resolve=>setImmediate(resolve));
    current={...current,credentialVersion:"present:new"};release(result);
    expect((await request)[0]?.windows).toEqual([]);
    await service.close();
  });
  it("rejects a credential replacement when metadata still carries proof for the old token",async()=>{
    let current:QuotaAccount={...account,credentialVersion:"present:old",identityCredentialVersion:"present:old",requireIdentityVerification:true};
    const service=createUsageService({getAccounts:async()=>[current],fetchUsage:async()=>{
      current={...current,credentialVersion:"present:replacement"};
      return result;
    }});
    try {expect((await service.refresh())[0]).toMatchObject({windows:[],fetchedAt:null});}
    finally {await service.close();}
  });
  it("accepts native token rotation when before and after probes prove the same identity",async()=>{
    let current:QuotaAccount={...account,credentialVersion:"present:old",identityCredentialVersion:"present:old",requireIdentityVerification:true};
    const service=createUsageService({getAccounts:async()=>[current],fetchUsage:async()=>{
      current={...current,credentialVersion:"present:new",identityCredentialVersion:"present:new"};
      return result;
    }});
    try {expect((await service.refresh())[0]).toMatchObject({status:"ok",windows:result.windows});}
    finally {await service.close();}
  });
  it("does not accept a rotated credential response without a bound response identity",async()=>{
    let current:QuotaAccount={...account,credentialVersion:"present:old",identityCredentialVersion:"present:old",requireIdentityVerification:true};
    let rotate=false;
    const service=createUsageService({getAccounts:async()=>[current],fetchUsage:async()=>{
      if(!rotate)return result;
      current={...current,credentialVersion:"present:new",identityCredentialVersion:"present:new"};
      return {...result,identityKey:null,windows:[{...result.windows[0]!,usedPercent:99}]};
    }});
    try {
      await service.refresh();rotate=true;
      expect((await service.refresh())[0]).toMatchObject({status:"stale",windows:result.windows});
    } finally {await service.close();}
  });
  it("retains stale success without sending a request when the native identity cannot be verified",async()=>{
    let current:QuotaAccount={...account,credentialVersion:"present:old",identityCredentialVersion:"present:old",requireIdentityVerification:true};
    let verificationFails=false;
    const fetchUsage=vi.fn(async()=>result);
    const service=createUsageService({getAccounts:async input=>{
      if(input?.verifyAccountId&&verificationFails)current={...current,identityCredentialVersion:undefined};
      return [current];
    },fetchUsage});
    try {
      await service.refresh();verificationFails=true;
      expect((await service.refresh())[0]).toMatchObject({status:"stale",windows:result.windows});
      expect(fetchUsage).toHaveBeenCalledTimes(1);
    } finally {await service.close();}
  });
  it("preserves stale quotas and Retry-After across proven rotations without idle or manual revalidation",async()=>{
    let now=0;
    let current:QuotaAccount={...account,credentialVersion:"present:old",identityCredentialVersion:"present:old",requireIdentityVerification:true};
    let limited=false;
    let verifications=0;
    const fetchUsage=vi.fn(async()=>{
      if(limited){current={...current,credentialVersion:"present:rotated",identityCredentialVersion:"present:rotated"};throw new UsageError("unavailable","rate_limited",600000);}
      return result;
    });
    const service=createUsageService({getAccounts:async input=>{if(input?.verifyAccountId)verifications++;return [current];},fetchUsage,now:()=>now});
    try {
      await service.refresh();limited=true;
      const delayed=(await service.refresh())[0]!;
      expect(delayed).toMatchObject({status:"stale",windows:result.windows,nextRetryAt:new Date(600000).toISOString()});
      current={...current,credentialVersion:"present:again",identityCredentialVersion:"present:again"};
      now=300000;
      for(let attempt=0;attempt<3;attempt++){await service.list({visible:true});expect((await service.refresh())[0]).toEqual(delayed);}
      expect(verifications).toBe(4);expect(fetchUsage).toHaveBeenCalledTimes(2);
      now=600000;limited=false;
      expect((await service.refresh())[0]?.status).toBe("ok");
      expect(verifications).toBe(6);
    } finally {await service.close();}
  });
  it("backs off and preserves stale data when post-request account verification fails",async()=>{
    let failVerification=false;
    let pendingFailure=false;
    let verifications=0;
    const fetchUsage=vi.fn(async()=>{pendingFailure=failVerification;return result;});
    const service=createUsageService({getAccounts:async input=>{
      if(input?.verifyAccountId){verifications++;if(pendingFailure){pendingFailure=false;throw new Error("private discovery detail");}}
      return [account];
    },fetchUsage});
    try {
      await service.refresh();failVerification=true;
      expect((await service.refresh())[0]).toMatchObject({status:"stale",windows:result.windows,error:"The limits service is temporarily unavailable."});
      await service.refresh();expect(verifications).toBe(4);expect(fetchUsage).toHaveBeenCalledTimes(2);
    } finally {await service.close();}
  });
  it("shows fresh unknown-identity quotas but never persists or reuses them after failure", async () => {
    const directory=await mkdtemp(join(tmpdir(),"paseo-usage-unknown-"));
    const cachePath=join(directory,"usage.json");
    const unknown={...account,identityKey:null,credentialVersion:"absent"};
    let failing=false;
    try {
      const service=createUsageService({getAccounts:async()=>[unknown],cachePath,fetchUsage:async()=>{if(failing)throw new UsageError("unavailable","request_failed");return result;}});
      expect((await service.refresh())[0]).toMatchObject({status:"ok",windows:result.windows});
      expect(JSON.parse(await readFile(cachePath,"utf8")).entries).toEqual([]);
      failing=true;
      expect((await service.refresh())[0]).toMatchObject({status:"unavailable",windows:[],fetchedAt:null});
      await service.close();
      const restored=createUsageService({getAccounts:async()=>[unknown],cachePath,fetchUsage:async()=>result});
      expect((await restored.list())[0]?.windows).toEqual([]);
      await restored.close();
    } finally {await rm(directory,{recursive:true,force:true});}
  });
});
