import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountController } from "../server/controller";
import { UsageError } from "../server/usage";

const boundary=vi.hoisted(()=>({fetch:vi.fn(),probe:vi.fn()}));
vi.mock("../server/auth",async original=>({...await original<typeof import("../server/auth")>(),probeAccount:boundary.probe}));
vi.mock("../server/usage",async original=>{
  const actual=await original<typeof import("../server/usage")>();
  return {...actual,readCredentialVersion:vi.fn(async()=>"present:fixture"),createUsageService:(options:Parameters<typeof actual.createUsageService>[0])=>{
    const service=actual.createUsageService({...options,fetchUsage:boundary.fetch});
    return {...service,start:vi.fn()};
  }};
});
const roots:string[]=[];
afterEach(async()=>{vi.clearAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const identity={identityKey:"fixture-identity",email:null,plan:null,authStatus:"ready" as const};
const result={identityKey:identity.identityKey,plan:"max",windows:[{id:"five_hour",label:"5 hours",usedPercent:23,windowDurationMins:300,resetsAt:null}]};

describe("controller quota verification",()=>{
  it("allows fresh unknown-identity quota data without saving it",async()=>{
    const root=await mkdtemp(join(tmpdir(),"quota-unknown-controller-"));roots.push(root);
    boundary.probe.mockResolvedValue({...identity,identityKey:null,authStatus:"unknown"});boundary.fetch.mockResolvedValue(result);
    const controller=new AccountController(root);await controller.ready;
    try {
      await controller.store.change(state=>{state.commands.codex=[process.execPath];});
      expect((await controller.usage.refresh("system-codex"))[0]).toMatchObject({status:"ok",windows:result.windows});
      expect(JSON.parse(await readFile(join(root,"usage-cache.json"),"utf8")).entries).toEqual([]);
    } finally {await controller.close();}
  });
  it("stages a cold-start cache until identity proof, then restores stale data on collector failure",async()=>{
    const root=await mkdtemp(join(tmpdir(),"quota-restart-"));roots.push(root);
    boundary.probe.mockResolvedValue(identity);boundary.fetch.mockResolvedValue(result);
    const first=new AccountController(root);await first.ready;
    await first.store.change(state=>{state.commands.claude=[process.execPath];});
    expect((await first.usage.refresh("system-claude"))[0]).toMatchObject({status:"ok",windows:result.windows});
    await first.close();
    const restarted=new AccountController(root);await restarted.ready;
    try {
      expect((await restarted.usage.list())[0]?.windows).toEqual([]);
      expect(JSON.parse(await readFile(join(root,"usage-cache.json"),"utf8")).entries).toHaveLength(1);
      boundary.fetch.mockRejectedValue(new UsageError("unavailable","network"));
      const snapshot=(await restarted.usage.refresh("system-claude"))[0];
      expect(snapshot).toMatchObject({status:"stale",windows:result.windows});
    } finally {await restarted.close();}
  });
});
