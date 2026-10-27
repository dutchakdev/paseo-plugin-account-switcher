import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../server/store";
import type { PaseoApi } from "@getpaseo/client";
import { SwitchRefusal, SwitchService, type SwitchDependencies } from "../server/switching";
import { AccountController } from "../server/controller";
import { atomicWrite } from "../server/files";
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

async function fixture() {
 const root=await mkdtemp(join(tmpdir(),"switch-test-"));roots.push(root);
 const store=new AccountStore(root);await store.initialize({claude:join(root,"claude"),codex:join(root,"codex")});
 await store.change(r=>{r.integration.enabled=true;});
 const target=await store.add("codex","Second");
 let busy=true,reloads=0;
 const service=new SwitchService({store,
  inspect:async()=>({provider:"codex",busy,archived:false}),
  checkAccount:async()=>({authStatus:"ready"}),
  reload:async(id)=>{reloads++;const b=(await store.read()).bindings.find(b=>b.agentId===id)!;
    await atomicWrite(join(root,"receipts",encodeURIComponent(id)+".json"),JSON.stringify({accountId:b.launchAccountId,launchToken:b.launchToken,pid:1,at:new Date().toISOString()}));},
 });
 return {store,service,target,setBusy:(v:boolean)=>{busy=v;},reloads:()=>reloads};
}

it("prepares while streaming and reloads only after explicit apply when idle",async()=>{
 const f=await fixture();await f.service.prepare("agent-1",f.target.id);
 await expect(f.service.apply("agent-1")).rejects.toThrow(/response/);
 expect(f.reloads()).toBe(0);
 expect((await f.store.snapshot()).bindings[0]?.currentAccountId).toBe("system-codex");
 f.setBusy(false);
 const applied=await f.service.apply("agent-1");
 expect(applied.currentAccountId).toBe(f.target.id);expect(applied.pendingAccountId).toBeNull();expect(f.reloads()).toBe(1);
 expect((await f.store.read()).bindings[0].launchToken).toBeNull();
});

it("does not switch or bind new agents for a provider that integration does not include",async()=>{
 const f=await fixture();f.setBusy(false);
 await f.store.change(r=>{r.integration.providers=["claude"];r.defaults.codex=f.target.id;});
 await f.service.prepare("agent-1",f.target.id);
 await expect(f.service.apply("agent-1")).rejects.toThrow("Account switching is off for Codex");
 expect(f.reloads()).toBe(0);
 expect((await f.store.read()).bindings[0]).toMatchObject({currentAccountId:"system-codex",pendingAccountId:f.target.id,status:"ready",launchToken:null});
 await f.service.bindNewAgent("new-agent","codex");
 expect((await f.store.read()).bindings.some(b=>b.agentId==="new-agent")).toBe(false);
});

function deferred() {
 let resolve!:()=>void;
 const promise=new Promise<void>(done=>{resolve=done;});
 return{promise,resolve};
}
async function writeReceipt(store:AccountStore,agentId:string,overrides:Record<string,unknown>={}) {
 const binding=(await store.read()).bindings.find(b=>b.agentId===agentId)!;
 await atomicWrite(join(store.root,"receipts",encodeURIComponent(agentId)+".json"),JSON.stringify({accountId:binding.launchAccountId,launchToken:binding.launchToken,pid:1,at:new Date().toISOString(),...overrides}));
}
function makeService(store:AccountStore,overrides:Partial<Omit<SwitchDependencies,"store">>={}) {
 return new SwitchService({store,inspect:async()=>({provider:"codex",busy:false,archived:false}),checkAccount:async()=>({authStatus:"ready"}),reload:id=>writeReceipt(store,id),receiptTimeoutMs:300,...overrides});
}

it("waits for a receipt from a provider CLI that starts after reload returns",async()=>{
 const {store,target}=await fixture();let started:Promise<void>|undefined;
 // The receipt lands 150 ms after reload returns; the margin must survive a slow CI runner.
 const service=makeService(store,{receiptTimeoutMs:3000,reload:async id=>{started=new Promise(done=>setTimeout(done,150)).then(()=>writeReceipt(store,id));}});
 await service.prepare("lazy-agent",target.id);
 expect(await service.apply("lazy-agent")).toMatchObject({currentAccountId:target.id,pendingAccountId:null,status:"ready"});
 await started;
});

it("fails when no provider CLI confirms the launch",async()=>{
 const {store,target}=await fixture();
 const service=makeService(store,{reload:async()=>{}});
 await service.prepare("silent-agent",target.id);
 await expect(service.apply("silent-agent")).rejects.toThrow("did not confirm");
 expect((await store.snapshot()).bindings[0]).toMatchObject({currentAccountId:null,pendingAccountId:target.id,status:"error"});
});

it("confirms the previous account with a fresh receipt after a failed reload",async()=>{
 const {store,target}=await fixture();let attempts=0;
 const launches:{accountId:string|null;token:string|null;current:string|null}[]=[];
 const service=makeService(store,{reload:async id=>{
  const binding=(await store.read()).bindings.find(b=>b.agentId===id)!;
  launches.push({accountId:binding.launchAccountId,token:binding.launchToken,current:binding.currentAccountId});
  if(++attempts===1)throw new Error("Native reload failed");
  await writeReceipt(store,id);
 }});
 await service.prepare("agent/rollback",target.id);
 await expect(service.apply("agent/rollback")).rejects.toThrow("Native reload failed");
 const binding=(await store.snapshot()).bindings[0];
 expect(binding).toMatchObject({currentAccountId:"system-codex",pendingAccountId:target.id,status:"error"});
 expect(binding.error).toContain("restored");
 expect(launches.map(launch=>launch.accountId)).toEqual([target.id,"system-codex"]);
 expect(launches[1].current).toBeNull();
 expect(launches[0].token).toBeTruthy();expect(launches[1].token).toBeTruthy();expect(launches[1].token).not.toBe(launches[0].token);
 expect((await store.read()).bindings[0].launchToken).toBeNull();
});

it.each(["failed reload","stale receipt"] as const)("keeps the running account unknown when rollback has %s",async failure=>{
 const {store,target}=await fixture();let attempts=0;let failedToken:string|null=null;
 const service=makeService(store,{reload:async id=>{
  attempts++;
  if(attempts===1){failedToken=(await store.read()).bindings[0].launchToken;throw new Error("Initial reload failed");}
  if(failure==="failed reload")throw new Error("Rollback failed");
  await writeReceipt(store,id,{launchToken:failedToken});
 }});
 await service.prepare("agent-unknown",target.id);
 await expect(service.apply("agent-unknown")).rejects.toThrow("Initial reload failed");
 expect(attempts).toBe(2);
 const binding=(await store.snapshot()).bindings[0];
 expect(binding).toMatchObject({currentAccountId:null,pendingAccountId:target.id,status:"error"});
 expect(binding.error).toContain("not confirmed");expect(binding.error).not.toContain("restored");
 expect((await store.read()).bindings[0].launchToken).toBeNull();
 await service.prepare("agent-unknown",target.id);
 expect((await store.read()).bindings[0]).toMatchObject({currentAccountId:null,launchToken:null});
});

it("preserves a newer selection that arrives before the switch claims its launch",async()=>{
 const {store,target}=await fixture(),newer=await store.add("codex","Newer choice");
 const checked=deferred(),continueCheck=deferred(),reload=vi.fn(async()=>{});
 const service=makeService(store,{checkAccount:async()=>{checked.resolve();await continueCheck.promise;return{authStatus:"ready"};},reload});
 await service.prepare("agent-stale",target.id);
 const outcome=service.apply("agent-stale").then(()=>null,error=>error as Error);
 await checked.promise;
 await store.prepare("agent-stale","codex",newer.id);
 continueCheck.resolve();
 expect(await outcome).toBeInstanceOf(Error);expect((await outcome)?.message).toContain("changed");
 expect(reload).not.toHaveBeenCalled();
 expect((await store.read()).bindings[0]).toMatchObject({currentAccountId:"system-codex",pendingAccountId:newer.id,launchAccountId:"system-codex",launchToken:null,status:"ready",error:null});
});

it("shares an applying lock between services until the first operation finishes",async()=>{
 const {store,target}=await fixture(),applying=new Set<string>();
 const checked=deferred(),continueCheck=deferred(),reload=vi.fn((id:string)=>writeReceipt(store,id));
 const first=makeService(store,{applying,checkAccount:async()=>{checked.resolve();await continueCheck.promise;return{authStatus:"ready"};},reload});
 const second=makeService(store,{applying,reload});
 await first.prepare("shared-agent",target.id);
 const result=first.apply("shared-agent");
 await checked.promise;
 await expect(second.apply("shared-agent")).rejects.toThrow("already in progress");
 await expect(second.prepare("shared-agent","system-codex")).rejects.toThrow("already in progress");
 expect(reload).not.toHaveBeenCalled();expect(applying.has("shared-agent")).toBe(true);
 continueCheck.resolve();
 expect((await result).currentAccountId).toBe(target.id);expect(reload).toHaveBeenCalledTimes(1);expect(applying.size).toBe(0);
 expect((await second.prepare("shared-agent","system-codex")).pendingAccountId).toBe("system-codex");
});

it.each(["before preflight","during preflight"] as const)("blocks an account with an active login token %s",async timing=>{
 const {store,target}=await fixture();const reload=vi.fn(async()=>{}),checkAccount=vi.fn(async()=>{
  if(timing==="during preflight")await store.change(registry=>{registry.accounts.find(account=>account.id===target.id)!.loginToken="login-in-progress";});
  return{authStatus:"ready"};
 });
 const service=makeService(store,{reload,checkAccount});await service.prepare("login-agent",target.id);
 if(timing==="before preflight")await store.change(registry=>{registry.accounts.find(account=>account.id===target.id)!.loginToken="login-in-progress";});
 await expect(service.apply("login-agent")).rejects.toThrow(/sign(?:ing)?[ -]in/i);
 expect(reload).not.toHaveBeenCalled();expect(checkAccount).toHaveBeenCalledTimes(timing==="before preflight"?0:1);
 expect((await store.read()).bindings[0]).toMatchObject({currentAccountId:"system-codex",pendingAccountId:target.id,launchAccountId:"system-codex",launchToken:null,status:"ready"});
});

it("keeps a default binding unconfirmed until a matching receipt and a successful native start",async()=>{
 const {store,target}=await fixture();await store.change(registry=>{registry.defaults.codex=target.id;registry.commands={claude:[process.execPath],codex:[process.execPath]};});
 const service=makeService(store);await service.bindNewAgent("default/agent","codex");
 const before=(await store.read()).bindings[0];
 expect(before).toMatchObject({currentAccountId:null,pendingAccountId:null,launchAccountId:target.id});expect(before.launchToken).toBeTruthy();
 // Closing immediately suppresses the controller's quota worker; all SDK calls
 // below use this fixture and never contact a daemon or a provider CLI.
 const controller=new AccountController(store.root);await controller.close();await controller.ready;
 let status="initializing";
 const paseo={
  config:{get:async()=>({config:{providers:{
   claude:{command:[join(store.root,"bin","claude-launcher")],env:{CLAUDE_CONFIG_DIR:join(store.root,"claude")}},
   codex:{command:[join(store.root,"bin","codex-launcher")],env:{CODEX_HOME:join(store.root,"codex")}},
  }}})},
  agents:{ref:()=>({refresh:async()=>({agent:{status}})})},
 } as unknown as PaseoApi;
 try{
  expect((await controller.snapshot(paseo)).bindings[0].currentAccountId).toBeNull();
  await writeReceipt(store,"default/agent",{launchToken:"old-token"});
  status="idle";expect((await controller.snapshot(paseo)).bindings[0].currentAccountId).toBeNull();
  await writeReceipt(store,"default/agent",{accountId:"system-codex"});
  expect((await controller.snapshot(paseo)).bindings[0].currentAccountId).toBeNull();
  await writeReceipt(store,"default/agent");
  status="initializing";expect((await controller.snapshot(paseo)).bindings[0].currentAccountId).toBeNull();
  status="idle";expect((await controller.snapshot(paseo)).bindings[0].currentAccountId).toBe(target.id);
 }finally{await controller.close();}
});

it.each(["needs_auth","unknown","error"])("rejects a new default session when the official auth probe returns %s",async authStatus=>{
 const {store,target}=await fixture();await store.change(r=>{r.defaults.codex=target.id;});
 const checkAccount=vi.fn(async()=>({authStatus}));
 const service=makeService(store,{checkAccount});
 await expect(service.bindNewAgent("not-started","codex")).rejects.toThrow(/requires authentication/);
 expect(checkAccount).toHaveBeenCalledWith(target.id);
 expect((await store.read()).bindings).toEqual([]);
});

it("does not bind an unprobed replacement default chosen during the first account's probe",async()=>{
 const {store,target}=await fixture(),other=await store.add("codex","Replacement");
 await store.change(r=>{r.defaults.codex=target.id;});
 const service=makeService(store,{checkAccount:async()=>{await store.change(r=>{r.defaults.codex=other.id;});return{authStatus:"ready"};}});
 await expect(service.bindNewAgent("racing-default","codex")).rejects.toThrow(/changed/);
 expect((await store.read()).bindings).toEqual([]);
 expect((await store.read()).defaults.codex).toBe(other.id);
});

describe("a new agent's account when the default would fail",()=>{
 const later=new Date(Date.now()+3_600_000).toISOString();
 const snapshot=(accountId:string,usedPercent:number,models?:string[])=>({accountId,provider:"codex" as const,status:"ok" as const,plan:null,
  windows:[{id:"primary",label:"5 hours",usedPercent,windowDurationMins:300,resetsAt:later,scope:"account" as const}],models,fetchedAt:later,checkedAt:later,nextRetryAt:null,error:null});
 async function pool(){
  const {store,target}=await fixture(),spare=await store.add("codex","Spare");
  await store.change(r=>{r.defaults.codex=target.id;for(const a of r.accounts)a.authStatus="ready";});
  return {store,target,spare};
 }
 const launched=async(store:AccountStore,agentId:string)=>(await store.read()).bindings.find(b=>b.agentId===agentId)?.launchAccountId;
 it("starts on the account with the most room when the default's limit is used up",async()=>{
  const {store,target,spare}=await pool();
  const service=makeService(store,{usage:async()=>[snapshot(target.id,100),snapshot("system-codex",70),snapshot(spare.id,20)]});
  await expect(service.bindNewAgent("after-limit","codex")).resolves.toEqual({accountId:spare.id,defaultId:target.id,reason:"exhausted"});
  expect(await launched(store,"after-limit")).toBe(spare.id);
 });
 it("starts on an account whose plan offers the agent's model",async()=>{
  const {store,target,spare}=await pool();
  const service=makeService(store,{usage:async()=>[snapshot(target.id,0,["gpt-6-luna"]),snapshot("system-codex",0,["gpt-6-luna"]),snapshot(spare.id,50,["gpt-6.1-sol"])]});
  await expect(service.bindNewAgent("paid-model","codex","gpt-6.1-sol")).resolves.toMatchObject({accountId:spare.id,reason:"model"});
  expect(await launched(store,"paid-model")).toBe(spare.id);
 });
 it("keeps the default while nothing shows it would fail",async()=>{
  const {store,target,spare}=await pool();
  const service=makeService(store,{usage:async()=>[snapshot(target.id,90),snapshot(spare.id,0)]});
  await expect(service.bindNewAgent("healthy","codex","gpt-6.1-sol")).resolves.toEqual({accountId:target.id,defaultId:target.id,reason:null});
  expect(await launched(store,"healthy")).toBe(target.id);
 });
 it("moves on to the next account when the default's sign-in probe fails",async()=>{
  const {store,target}=await pool();
  const checkAccount=vi.fn(async(id:string)=>({authStatus:id===target.id?"needs_auth":"ready"}));
  await expect(makeService(store,{checkAccount}).bindNewAgent("signed-out-default","codex")).resolves.toMatchObject({reason:"sign-in"});
  expect(await launched(store,"signed-out-default")).not.toBe(target.id);
  expect(checkAccount.mock.calls[0][0]).toBe(target.id);
 });
 it("does not call a default that could not be checked one that needs sign-in",async()=>{
  const {store,target}=await pool();
  const checkAccount=vi.fn(async(id:string)=>({authStatus:id===target.id?"error":"ready"}));
  await expect(makeService(store,{checkAccount}).bindNewAgent("unchecked-default","codex")).resolves.toMatchObject({reason:"unverified"});
 });
 it("keeps a used-up default when fallback is off for its provider, as in 0.6.0",async()=>{
  const {store,target,spare}=await pool();
  await store.change(r=>{r.fallback.codex=false;});
  const checkAccount=vi.fn(async(_id:string)=>({authStatus:"ready"}));
  const service=makeService(store,{checkAccount,usage:async()=>[snapshot(target.id,100),snapshot(spare.id,0)]});
  await expect(service.bindNewAgent("pinned","codex")).resolves.toEqual({accountId:target.id,defaultId:target.id,reason:null});
  expect(checkAccount.mock.calls.map(([id])=>id)).toEqual([target.id]);
 });
 it("still requires sign-in on a pinned default instead of moving the agent",async()=>{
  const {store,target}=await pool();
  await store.change(r=>{r.fallback.codex=false;});
  const service=makeService(store,{checkAccount:async(id:string)=>({authStatus:id===target.id?"needs_auth":"ready"})});
  await expect(service.bindNewAgent("pinned-signed-out","codex")).rejects.toThrow(/requires authentication/);
 });
 it("falls back to the default when every account is used up, as before",async()=>{
  const {store,target,spare}=await pool();
  const service=makeService(store,{usage:async()=>[snapshot(target.id,100),snapshot("system-codex",100),snapshot(spare.id,100)]});
  await service.bindNewAgent("all-out","codex");
  expect(await launched(store,"all-out")).toBe(target.id);
 });
});

it("applies only the account the caller selected when another client changed the selection meanwhile",async()=>{
 const f=await fixture();f.setBusy(false);
 const other=await f.store.add("codex","Personal");
 await f.service.prepare("raced",f.target.id);
 await f.service.prepare("raced",other.id);
 await expect(f.service.apply("raced",f.target.id)).rejects.toThrow(/selection changed/);
 expect(f.reloads()).toBe(0);
 expect((await f.store.read()).bindings.find(b=>b.agentId==="raced")).toMatchObject({pendingAccountId:other.id,status:"ready"});
 await expect(f.service.apply("raced",other.id)).resolves.toMatchObject({currentAccountId:other.id});
});

describe("a switch the user did not select in the switcher",()=>{
 // The failover row's button and the automatic switch select and apply in one step.
 it("selects and applies the account in one step",async()=>{
  const {store,target}=await fixture();
  await expect(makeService(store).switchTo("one-step",target.id)).resolves.toMatchObject({currentAccountId:target.id,pendingAccountId:null,status:"ready"});
 });
 it("leaves no binding behind for an agent that had none when the switch is refused",async()=>{
  const {store,target}=await fixture();
  const service=makeService(store,{inspect:async()=>({provider:"codex",busy:true,archived:false})});
  await expect(service.switchTo("unbound",target.id)).rejects.toThrow("Wait for the agent to finish its response.");
  expect((await store.read()).bindings).toEqual([]);
 });
 it("puts the user's own selection back when the switch is refused before it starts",async()=>{
  const {store,target}=await fixture(),chosen=await store.add("codex","Chosen");
  await makeService(store).prepare("selected",chosen.id);
  await store.change(r=>{r.bindings[0].error="An earlier switch failed.";});
  const before=(await store.read()).bindings[0];
  const reload=vi.fn(async()=>{});
  const service=makeService(store,{reload,inspect:async()=>({provider:"codex",busy:true,archived:false})});
  await expect(service.switchTo("selected",target.id)).rejects.toThrow("Wait for the agent to finish its response.");
  expect(reload).not.toHaveBeenCalled();
  expect((await store.read()).bindings[0]).toEqual(before);
  // Nothing was selected before: nothing stays selected.
  await store.change(r=>{r.bindings[0].pendingAccountId=null;r.bindings[0].error=null;});
  await expect(service.switchTo("selected",target.id)).rejects.toThrow("Wait for the agent to finish its response.");
  expect((await store.read()).bindings[0]).toMatchObject({currentAccountId:"system-codex",pendingAccountId:null,status:"ready",error:null});
 });
 it("leaves a selection another client made meanwhile alone",async()=>{
  const {store,target}=await fixture(),other=await store.add("codex","Other client");
  const service=makeService(store,{checkAccount:async()=>{await store.prepare("raced","codex",other.id);return{authStatus:"ready"};}});
  await expect(service.switchTo("raced",target.id)).rejects.toThrow(/selection changed/);
  expect((await store.read()).bindings[0]).toMatchObject({pendingAccountId:other.id,status:"ready"});
 });
 it("rolls back as Apply does once the binding has started switching",async()=>{
  const {store,target}=await fixture();
  await expect(makeService(store,{reload:async()=>{}}).switchTo("silent",target.id)).rejects.toThrow("did not confirm");
  expect((await store.read()).bindings[0]).toMatchObject({currentAccountId:null,pendingAccountId:target.id,status:"error"});
 });
});

describe("what a failed switch may show",()=>{
 it("marks the service's own refusals, which are written for the user",async()=>{
  const {store,target}=await fixture();
  const busy=makeService(store,{inspect:async()=>({provider:"codex",busy:true,archived:false})});
  await busy.prepare("refused",target.id);
  await expect(busy.apply("refused")).rejects.toBeInstanceOf(SwitchRefusal);
  await expect(makeService(store,{reload:async()=>{}}).switchTo("unconfirmed",target.id)).rejects.toBeInstanceOf(SwitchRefusal);
 });
 it("passes any other failure on unmarked",async()=>{
  const {store,target}=await fixture();
  const raw=Object.assign(new Error("EACCES: permission denied, open '/Users/me/.paseo/config.json'"),{code:"EACCES"});
  const failure=makeService(store,{reload:async()=>{throw raw;}}).switchTo("raw",target.id);
  await expect(failure).rejects.toBe(raw);
  await expect(failure).rejects.not.toBeInstanceOf(SwitchRefusal);
 });
});
