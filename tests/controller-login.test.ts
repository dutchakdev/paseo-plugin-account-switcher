import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { AccountController } from "../server/controller";
import { atomicWrite } from "../server/files";
import type { QuotaAccount, UsageOptions } from "../server/usage";

const boundaries=vi.hoisted(()=>({probe:vi.fn(),launch:vi.fn(),fetch:vi.fn()}));
vi.mock("../server/auth",async importOriginal=>({
  ...await importOriginal<typeof import("../server/auth")>(),
  probeAccount:boundaries.probe,
  launchLogin:boundaries.launch,
}));
vi.mock("../server/usage",async importOriginal=>{
  const original=await importOriginal<typeof import("../server/usage")>();
  return {...original,readCredentialVersion:vi.fn(async()=>"present:fixture"),createUsageService:(options:UsageOptions)=>original.createUsageService({...options,fetchUsage:boundaries.fetch})};
});

const roots:string[]=[];
const controllers:AccountController[]=[];
const session={workspaceId:"login-workspace",terminalId:"login-terminal"};
const windows=[{id:"fixture:primary",label:"5 hours",usedPercent:12,windowDurationMins:300,resetsAt:null}];
beforeEach(()=>{
  boundaries.probe.mockReset().mockResolvedValue({identityKey:"fixture-identity",email:"fixture@example.test",plan:"plus",authStatus:"ready"});
  boundaries.launch.mockReset().mockResolvedValue(session);
  boundaries.fetch.mockReset().mockImplementation(async(account:QuotaAccount)=>({identityKey:account.identityKey,plan:"plus",windows}));
});
afterEach(async()=>{
  await Promise.all(controllers.splice(0).map(controller=>controller.close()));
  await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));
});

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"account-controller-"));roots.push(root);
  const controller=new AccountController(root);controllers.push(controller);await controller.ready;
  const config={providers:{claude:{command:[process.execPath],env:{CLAUDE_CONFIG_DIR:join(root,"source-claude")}},codex:{command:[process.execPath],env:{CODEX_HOME:join(root,"source-codex")}}}};
  const terminal={...session,id:session.terminalId,cwd:join(root,"login"),name:"Fixture login"};
  let exists=true;
  const kill=vi.fn(async()=>{exists=false;});
  const list=vi.fn(async()=>({entries:exists?[terminal]:[],requestId:"fixture"}));
  const paseo={config:{get:async()=>({config})},terminals:{list,ref:vi.fn(()=>({id:session.terminalId,kill,refresh:async()=>exists?terminal:null}))}} as unknown as PaseoApi;
  await controller.ensureRuntime(paseo);
  const account=await controller.store.add("codex","Fixture subscription");
  terminal.cwd=join(root,"login",account.id);
  return{root,controller,account,paseo,kill,list};
}

describe("Paseo account login lifecycle",()=>{
  it("automatically turns a completed native receipt into a ready account and quota data",async()=>{
    const {root,controller,account,paseo}=await fixture();
    await controller.login(paseo,account.id);
    const pending=(await controller.store.read()).accounts.find(row=>row.id===account.id)!;
    expect(pending.loginToken).toBeTruthy();expect(pending.login).toEqual(session);
    await atomicWrite(join(root,"logins",account.id+".json"),JSON.stringify({loginToken:pending.loginToken,exitCode:0,finishedAt:new Date().toISOString()}));
    // This is the background discovery path, with no auth.check/finishLogin call.
    await controller.quotaAccounts();
    const ready=(await controller.snapshot(paseo)).accounts.find(row=>row.id===account.id)!;
    expect(ready).toMatchObject({authStatus:"ready",email:"fixture@example.test",login:null});
    expect((await controller.store.read()).accounts.find(row=>row.id===account.id)?.loginToken).toBeNull();
    await vi.waitFor(async()=>{
      const usage=(await controller.usage.list()).find(row=>row.accountId===account.id);
      expect(usage).toMatchObject({status:"ok",windows});
    });
    expect(boundaries.fetch).toHaveBeenCalledWith(expect.objectContaining({id:account.id}),expect.anything());
  });

  it("keeps the public login terminal link when the controller restarts",async()=>{
    const {root,controller,account,paseo}=await fixture();
    await controller.login(paseo,account.id);await controller.close();
    const restarted=new AccountController(root);controllers.push(restarted);await restarted.ready;
    expect((await restarted.snapshot(paseo)).accounts.find(row=>row.id===account.id)?.login).toEqual(session);
    expect((await restarted.store.read()).accounts.find(row=>row.id===account.id)?.loginToken).toBeTruthy();
    expect(boundaries.launch).toHaveBeenCalledTimes(1);
  });

  it("keeps the login lock and terminal link if terminal termination fails",async()=>{
    const {controller,account,paseo,kill}=await fixture();
    await controller.login(paseo,account.id);
    const before=(await controller.store.read()).accounts.find(row=>row.id===account.id)!;
    kill.mockRejectedValueOnce(new Error("synthetic terminal kill failure"));
    await expect(controller.cancelLogin(paseo,account.id)).rejects.toThrow();
    expect((await controller.store.read()).accounts.find(row=>row.id===account.id)).toMatchObject({loginToken:before.loginToken,login:session});
  });

  it("clears a cancelled login only after the terminal has been terminated",async()=>{
    const {controller,account,paseo,kill}=await fixture();
    await controller.login(paseo,account.id);
    kill.mockImplementationOnce(async()=>{
      const pending=(await controller.store.read()).accounts.find(row=>row.id===account.id)!;
      expect(pending.loginToken).toBeTruthy();expect(pending.login).toEqual(session);
    });
    await controller.cancelLogin(paseo,account.id);
    expect(kill).toHaveBeenCalledTimes(1);
    expect((await controller.store.read()).accounts.find(row=>row.id===account.id)).toMatchObject({loginToken:null,login:null});
    expect((await controller.snapshot(paseo)).accounts.find(row=>row.id===account.id)?.login).toBeNull();
  });

  it("does not let a probe from before login overwrite the identity from the new sign-in",async()=>{
    const {root,controller,account,paseo}=await fixture();
    let releaseProbe!:()=>void;
    let reportProbeStarted!:()=>void;
    const probeStarted=new Promise<void>(resolve=>{reportProbeStarted=resolve;});
    const pendingProbe=new Promise<void>(resolve=>{releaseProbe=resolve;});
    let oldRead=true;
    boundaries.probe.mockImplementation(async(candidate:{id:string})=>{
      if(candidate.id===account.id&&oldRead){oldRead=false;reportProbeStarted();await pendingProbe;return{identityKey:"before-login",email:"old@example.test",plan:"plus",authStatus:"ready"};}
      return{identityKey:"after-login",email:"new@example.test",plan:"plus",authStatus:"ready"};
    });
    const previousCheck=controller.checkAccount(account.id).catch(()=>null);
    await probeStarted;
    const login=controller.login(paseo,account.id);
    try {
      await vi.waitFor(async()=>{expect((await controller.store.read()).accounts.find(row=>row.id===account.id)?.loginToken).toBeTruthy();});
      // The new terminal must wait until the old probe cannot commit its identity.
      expect(boundaries.launch).not.toHaveBeenCalled();
    } finally {releaseProbe();await previousCheck;await login;}
    const reserved=(await controller.store.read()).accounts.find(row=>row.id===account.id)!;
    expect(reserved.identityKey).not.toBe("before-login");
    await atomicWrite(join(root,"logins",account.id+".json"),JSON.stringify({loginToken:reserved.loginToken,exitCode:0,finishedAt:new Date().toISOString()}));
    await controller.quotaAccounts();
    expect((await controller.snapshot(paseo)).accounts.find(row=>row.id===account.id)).toMatchObject({email:"new@example.test",authStatus:"ready",login:null});
  });
});
