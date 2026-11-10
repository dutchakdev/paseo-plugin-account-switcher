import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuationCoordinator, type ContinuationHost, type RecoveryEvent, type RecoveryView } from "../server/continuation";
import { ContinuationLedger, type ContinuationOperation, type OperationLedger } from "../server/continuation-ledger";
import { RegistrySchema } from "../server/store";
import type { PaseoApi } from "../server/paseo-api";
import type { UsageSnapshot } from "../shared/contracts";
import { recoveryDecision } from "../server/failover";
import { readClaudeTurnMessageId } from "../server/continuation-timeline";
import { ContinuationObservation } from "../server/continuation-observation";
import { parseClaudeQuota } from "../server/claude-quota";

const paseo={} as PaseoApi;
const NOW=Date.parse("2026-11-10T10:00:00Z"),at=new Date(NOW).toISOString();
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
class MemoryLedger implements OperationLedger{
 operations:ContinuationOperation[]=[];
 async read(){return structuredClone(this.operations);}
 async add(op:ContinuationOperation){if(this.operations.some(o=>o.key===op.key))return false;this.operations.push(structuredClone(op));return true;}
 async update(key:string,state:ContinuationOperation["state"],now:number){const op=this.operations.find(o=>o.key===key)!;op.state=state;op.updatedAt=now;if(state==="switching")op.attemptedAt=now;}
}
function fixture(provider:"claude"|"codex"="claude",automatic=true,ledger:OperationLedger=new MemoryLedger()){
 let now=NOW;
 const account=(id:string,identityKey=id)=>({id,identityKey,provider,label:id,source:"managed",home:`/profiles/${id}`,email:null,plan:null,authStatus:"ready",createdAt:at,generation:1,loginToken:null});
 const view:RecoveryView={accountId:"source",registry:RegistrySchema.parse({version:1,accounts:[account("source"),account("target")],bindings:[],defaults:{claude:null,codex:null},sourceHomes:{claude:"/source",codex:"/source"},commands:{claude:null,codex:null},originalCommands:{claude:null,codex:null},integration:{enabled:true,error:null,providers:[provider]},autoFailover:{claude:automatic,codex:automatic}}),agent:{id:"agent",provider,cwd:"/cwd",model:"model",sessionId:"native",workspaceId:"workspace",status:"idle",activeTurn:false,pendingPermissions:[],archived:false,lastUserMessageAt:at}};
 const usage=(accountId:string,usedPercent:number,extra:Partial<UsageSnapshot>={}):UsageSnapshot=>({accountId,provider,status:"ok",plan:null,windows:[{id:"account",label:"5h",scope:"account",usedPercent,windowDurationMins:300,resetsAt:new Date(now+3_600_000).toISOString()}],fetchedAt:new Date(now).toISOString(),checkedAt:new Date(now).toISOString(),nextRetryAt:null,error:null,...extra});
 let readings=[usage("source",100),usage("target",10)];
 let coordinator:ContinuationCoordinator;
 const host:ContinuationHost={
  read:vi.fn(async()=>structuredClone(view)),
  refresh:vi.fn(async()=>structuredClone(readings)),
  claudeMessageId:vi.fn(async()=>"msg_native_terminal"),
  claude:vi.fn(async()=>({errorId:"native-error",userId:"native-user"})),
  switch:vi.fn(async(_p,id,target,op)=>{
   for(const stage of ["afterRead","afterInspect","afterAccountCheck","afterBinding","beforeReload","afterReload","afterReceipt"] as const)await op.guard(stage);
   view.accountId=target;
   await op.afterConfirmed();
  }),
  send:vi.fn(async()=>{}),row:vi.fn(async()=>{}),now:()=>now,
 };
 coordinator=new ContinuationCoordinator(ledger,host);
 const event:RecoveryEvent={agent:{id:"agent",provider,cwd:"/cwd",parentAgentId:null},turnId:"turn",outcome:provider==="claude"?{kind:"completed"}:{kind:"failed",error:{code:"usage_limit_reached",message:"quota"}}};
 return{view,host,coordinator,event,ledger,usage,readings,setReadings:(r:UsageSnapshot[])=>{readings=r;},setNow:(n:number)=>{now=n;},start:()=>coordinator.started(event,paseo),end:()=>coordinator.ended(event,paseo),rows:()=>vi.mocked(host.row).mock.calls.map(c=>c[2])};
}

describe("native quota continuation coordinator",()=>{
 it.each(["claude","codex"] as const)("switches and continues one evidenced %s interruption once",async provider=>{
  const f=fixture(provider);f.start();await f.end();await f.end();
  expect(f.host.refresh).toHaveBeenCalledTimes(1);expect(f.host.switch).toHaveBeenCalledTimes(1);expect(f.host.send).toHaveBeenCalledTimes(1);
  expect(f.host.send).toHaveBeenCalledWith(paseo,"agent",expect.any(String));
  expect((await f.ledger.read())[0]).toMatchObject({state:"finished",sessionId:"native",turnId:"turn",resumes:true});
  expect(f.rows().map(r=>r.state)).toEqual(["switching","auto"]);
 });
 it("deduplicates hook/live errors and permits a new native error with a reused turn ID",async()=>{
  const f=fixture();f.start();await f.end();f.view.accountId="source";
  const baseline=await f.coordinator.capture(paseo,"agent");
  await f.coordinator.live(paseo,baseline!,"msg_native_terminal","turn",NOW+1);
  expect(f.host.send).toHaveBeenCalledTimes(1);
  f.start();vi.mocked(f.host.claude).mockResolvedValue({errorId:"second-error",userId:"second-user"});await f.end();
  expect((await f.ledger.read()).map(op=>op.errorId)).toEqual(["native-error","second-error"]);expect(f.host.send).toHaveBeenCalledTimes(2);
 });
 it("does not replay a pre-upgrade ambiguous record without an error ID",async()=>{
  const ledger=new MemoryLedger(),f=fixture("claude",true,ledger);f.start();await f.end();f.view.accountId="source";
  ledger.operations[0].key=JSON.stringify(["agent","native","turn"]);ledger.operations[0].errorId=null;ledger.operations[0].state="uncertain";
  f.start();await f.end();expect(f.host.send).toHaveBeenCalledTimes(1);expect(ledger.operations).toHaveLength(1);
 });
 it("uses a matching daemon turn start instead of delayed hook arrival",async()=>{
  const f=fixture();f.view.agent.activeTurnId="turn";f.view.agent.activeTurnStartedAt=new Date(NOW-500).toISOString();f.start();await f.end();
  expect(f.host.claude).toHaveBeenCalledWith(expect.objectContaining({startedAt:NOW-500,endedAt:NOW}));
 });
 it("preserves Accounts recovery coverage for a separately managed child agent",async()=>{
  const f=fixture();f.event.agent.parentAgentId="leader";f.start();await f.end();await f.end();
  expect(f.host.switch).toHaveBeenCalledTimes(1);expect(f.host.send).toHaveBeenCalledTimes(1);
  expect((await f.ledger.read())[0]).toMatchObject({state:"finished",agentId:"agent",turnId:"turn"});
 });
 it("never recovers without an observed stable current turn",async()=>{
  const f=fixture();await f.end();f.start();await f.coordinator.ended({...f.event,turnId:"old"},paseo);
  expect(f.host.refresh).not.toHaveBeenCalled();expect(f.host.switch).not.toHaveBeenCalled();
 });
 it("ordinary completed or quoted/old native text is not interruption evidence even with cached full quota",async()=>{
  const f=fixture();vi.mocked(f.host.claude).mockResolvedValue(null);f.start();await f.end();
  expect(f.host.refresh).not.toHaveBeenCalled();expect(f.host.switch).not.toHaveBeenCalled();expect(f.rows()).toEqual([]);
 });
 it("requires a current terminal assistant ID and positive native evidence",async()=>{
  for(const missing of [true,false]){
   const f=fixture();
   if(missing)vi.mocked(f.host.claudeMessageId).mockResolvedValue(null);
   else vi.mocked(f.host.claude).mockResolvedValue(null);
   f.start();await f.end();expect(f.host.refresh).not.toHaveBeenCalled();expect(f.host.send).not.toHaveBeenCalled();
  }
 });
 it.each([{kind:"completed"},{kind:"failed",error:{code:"429",message:"You've hit your usage limit"}},{kind:"failed",error:{message:"usage_limit_reached"}}])("Codex rejects nonexplicit error evidence (%j)",async outcome=>{
  const f=fixture("codex");f.event.outcome=outcome;f.start();await f.end();expect(f.host.refresh).not.toHaveBeenCalled();expect(f.host.send).not.toHaveBeenCalled();
 });
 it.each(["stale","unknown","same_identity","different_provider","signing_in","model","full","no_fetched_at","expired"])("rejects unsafe target %s",async kind=>{
  const f=fixture();const target=f.view.registry.accounts[1];
  if(kind==="stale")f.readings[1].status="stale";
  if(kind==="unknown")f.readings[1].windows=[];
  if(kind==="same_identity")target.identityKey="source";
  if(kind==="different_provider")target.provider="codex";
  if(kind==="signing_in")target.loginToken="pending-id";
  if(kind==="model")f.readings[1].models=["other"];
  if(kind==="full")f.readings[1].windows[0].usedPercent=100;
  if(kind==="no_fetched_at")f.readings[1].fetchedAt=null;
  if(kind==="expired")f.readings[1].checkedAt=new Date(NOW-130_000).toISOString();
  f.start();await f.end();expect(f.host.switch).not.toHaveBeenCalled();expect(f.host.send).not.toHaveBeenCalled();
 });
 it.each(["stale","not_full","extra_usage","unknown_identity"])("requires fresh exhausted source (%s)",async kind=>{
  const f=fixture();
  if(kind==="stale")f.readings[0].status="stale";
  if(kind==="not_full")f.readings[0].windows[0].usedPercent=20;
  if(kind==="unknown_identity")f.view.registry.accounts[0].identityKey=null;
  if(kind==="extra_usage")f.readings[0].windows.push({id:"spend",label:"paid",scope:"spend",usedPercent:20,windowDurationMins:null,resetsAt:null});
  f.start();await f.end();expect(f.host.send).not.toHaveBeenCalled();expect(f.host.switch).not.toHaveBeenCalled();
 });
 it("accepts an authoritative usageAllowed target without percentages",()=>{
  const f=fixture();const usage=[f.usage("source",100),f.usage("target",0,{windows:[],usageAllowed:true})];
  expect(recoveryDecision({currentId:"source",accounts:f.view.registry.accounts,usage,model:"model",now:NOW})).toMatchObject({kind:"offer",toId:"target"});
 });
 it.each(["stop","new_turn","permission","archive","close","model","session","provider","account_generation","new_message"])("does not send after %s during reload preparation",async kind=>{
  const f=fixture();
  vi.mocked(f.host.switch).mockImplementation(async(_p,_id,target,op)=>{
   await op.guard("beforeReload");
   if(kind==="stop")void f.coordinator.stop();
   if(kind==="new_turn")f.coordinator.started({...f.event,turnId:"new"},paseo);
   if(kind==="permission")f.coordinator.invalidate("agent");
   if(kind==="archive")f.view.agent.archived=true;
   if(kind==="close"){f.coordinator.closed("agent");f.view.agent.status="closed";}
   if(kind==="model")f.view.agent.model="changed";
   if(kind==="session")f.view.agent.sessionId="changed";
   if(kind==="provider")f.view.agent.provider="codex";
   if(kind==="account_generation")f.view.registry.accounts[1].generation++;
   if(kind==="new_message")f.view.agent.lastUserMessageAt=new Date(NOW+1).toISOString();
   await op.guard("afterReceipt");f.view.accountId=target;await op.afterConfirmed();
  });
  f.start();await f.end();expect(f.host.send).not.toHaveBeenCalled();expect((await f.ledger.read())[0].state).toBe("uncertain");
 });
 it.each(["initializing","closed"])("waits through its own %s reload boundary but requires an idle receipt",async status=>{
  const f=fixture();vi.mocked(f.host.switch).mockImplementation(async(_p,_id,target,op)=>{
   await op.guard("beforeReload");f.coordinator.closed("agent");f.view.agent.status=status;
   await op.guard("afterReload");expect(f.host.send).not.toHaveBeenCalled();
   f.view.agent.status="idle";await op.guard("afterReceipt");f.view.accountId=target;await op.afterConfirmed();
  });f.start();await f.end();expect(f.host.send).toHaveBeenCalledTimes(1);
 });
 it("an unready post-receipt snapshot cannot send",async()=>{
  const f=fixture();vi.mocked(f.host.switch).mockImplementation(async(_p,_id,_target,op)=>{
   await op.guard("beforeReload");f.view.agent.status="initializing";await op.guard("afterReload");await op.guard("afterReceipt");
  });f.start();await f.end();expect(f.host.send).not.toHaveBeenCalled();
 });
 it("allows only its own single reload close and aborts a second close",async()=>{
  for(const twice of [false,true]){
   const f=fixture();vi.mocked(f.host.switch).mockImplementation(async(_p,_id,target,op)=>{
    await op.guard("beforeReload");f.coordinator.closed("agent");if(twice)f.coordinator.closed("agent");
    await op.guard("afterReceipt");f.view.accountId=target;await op.afterConfirmed();
   });f.start();await f.end();expect(f.host.send).toHaveBeenCalledTimes(twice?0:1);
  }
 });
 it("refuses forged, stale, changed or resumed buttons instead of reconstructing rows",async()=>{
  const f=fixture("claude",false);f.start();await f.end();const row=f.rows()[0];
  await expect(f.coordinator.apply(paseo,{agentId:"agent",accountId:"target",rowId:"forged"})).rejects.toThrow(/\/account/);
  await expect(f.coordinator.apply(paseo,{agentId:"agent",accountId:"source",rowId:row.rowId})).rejects.toThrow();
  f.coordinator.invalidate("agent");await expect(f.coordinator.apply(paseo,{agentId:"agent",accountId:"target",rowId:row.rowId})).rejects.toThrow();
  expect(f.host.send).not.toHaveBeenCalled();
 });
 it("a saved button rechecks fresh quotas and continues once",async()=>{
  const f=fixture("claude",false);f.start();await f.end();const row=f.rows()[0];
  await f.coordinator.apply(paseo,{agentId:"agent",accountId:"target",rowId:row.rowId});
  await expect(f.coordinator.apply(paseo,{agentId:"agent",accountId:"target",rowId:row.rowId})).rejects.toThrow();
  expect(f.host.refresh).toHaveBeenCalledTimes(2);expect(f.host.send).toHaveBeenCalledTimes(1);
 });
 it("does not replay an ambiguous send or duplicate concurrent end/manual events",async()=>{
  const f=fixture();vi.mocked(f.host.send).mockRejectedValue(new Error("transport lost"));f.start();
  await Promise.all([f.end(),f.end()]);await f.end();
  const row=f.rows()[0];await expect(f.coordinator.apply(paseo,{agentId:"agent",accountId:"target",rowId:row.rowId})).rejects.toThrow();
  expect(f.host.switch).toHaveBeenCalledTimes(1);expect(f.host.send).toHaveBeenCalledTimes(1);expect((await f.ledger.read())[0].state).toBe("uncertain");
 });
 it("saves sending before calling send and keeps finished on successful delivery",async()=>{
  const f=fixture();vi.mocked(f.host.send).mockImplementation(async()=>{expect((await f.ledger.read())[0].state).toBe("sending");});
  f.start();await f.end();expect((await f.ledger.read())[0].state).toBe("finished");
 });
 it("user activity while refreshing or before the final send prevents continuation",async()=>{
  for(const stage of ["refresh","sending"]){
   const ledger=new MemoryLedger(),f=fixture("claude",true,ledger);
   if(stage==="refresh")vi.mocked(f.host.refresh).mockImplementation(async()=>{f.coordinator.invalidate("agent");return f.readings;});
   else{const update=ledger.update.bind(ledger);ledger.update=async(...args)=>{await update(...args);if(args[1]==="sending")f.coordinator.invalidate("agent");};}
   f.start();await f.end();expect(f.host.send).not.toHaveBeenCalled();
  }
 });
 it("a loaded operation cannot resume on a new coordinator",async()=>{
  const f=fixture("claude",false);f.start();await f.end();const row=f.rows()[0];
  const next=new ContinuationCoordinator(f.ledger,f.host);await expect(next.apply(paseo,{agentId:"agent",accountId:"target",rowId:row.rowId})).rejects.toThrow();
  next.started(f.event,paseo);await next.ended(f.event,paseo);expect(f.host.switch).not.toHaveBeenCalled();
 });
 it("enforces a persisted rolling three attempts/hour and does not return to a departed identity",async()=>{
  for(const mode of ["cap","return"]){
   const f=fixture();const ledger=f.ledger as MemoryLedger;
   const prototype:ContinuationOperation={key:"old",rowId:"old",agentId:"agent",sessionId:"old",turnId:"old",provider:"claude",fromId:"old",toId:"older",fromIdentity:"unused",toIdentity:"unused",createdAt:NOW-100,updatedAt:NOW-100,attemptedAt:NOW-100,state:"finished",messageId:"old",resumes:true,resetsAt:null,errorId:null,userId:null};
   if(mode==="cap")ledger.operations=[0,1,2].map(i=>({...prototype,key:String(i)}));
   else{const {createHash}=await import("node:crypto");ledger.operations=[{...prototype,fromIdentity:createHash("sha256").update("target").digest("hex")}];}
   f.start();await f.end();expect(f.host.switch).not.toHaveBeenCalled();
  }
 });
});

describe("public terminal assistant ID combined with the real native parser",()=>{
 const nativeSession="d8d1b5bf-7531-4277-8eae-a716b1fb2de5",nativeUser="95fe36f8-16f7-4734-85b8-03f55e0286cc",errorUUID="994571f8-886a-4892-b8be-48b0e02203c7",normalUUID="e4e1cc63-743a-47e2-9a2d-a23b44d47afb";
 const terminalId="msg_native_error",normalId="msg_native_normal";
 const user={type:"user",uuid:nativeUser,parentUuid:null,timestamp:new Date(NOW-50).toISOString(),sessionId:nativeSession,message:{role:"user",content:"Synthetic task"}};
 const nativeError={type:"assistant",uuid:errorUUID,parentUuid:nativeUser,timestamp:new Date(NOW).toISOString(),sessionId:nativeSession,isApiErrorMessage:true,error:"rate_limit",message:{id:terminalId,role:"assistant",content:[{type:"text",text:"Synthetic interruption"}]}};
 const publicEntry=(seq:number,type:string,messageId:string|undefined,turnId="turn")=>({provider:"claude",turnId,seqStart:seq,seqEnd:seq,item:{type,messageId,text:"not inspected"}});
 const response=(entries:unknown[])=>({agentId:"agent",direction:"tail",projection:"projected",epoch:"epoch",hasNewer:false,hasOlder:false,startCursor:null,reset:false,staleCursor:false,gap:false,error:null,entries});
 async function run(mode:"match"|"normal"|"missing"|"foreign"|"native_success"){
  const f=fixture();f.view.agent.sessionId=nativeSession;
  const final=publicEntry(3,"assistant_message",mode==="missing"?undefined:mode==="normal"||mode==="native_success"?normalId:terminalId,mode==="foreign"?"old":"turn");
  const entries=[publicEntry(1,"user_message","rewritten-paseo-client-id"),publicEntry(2,"assistant_message",terminalId),final];
  const timelinePaseo={agents:{ref:()=>({timeline:{refetch:async()=>response(entries)}})}} as unknown as PaseoApi;
  f.host.claudeMessageId=vi.fn(async(_p,id,turnId,check)=>readClaudeTurnMessageId(timelinePaseo,id,turnId,check));
  const nativeRows:unknown[]=[user,nativeError];
  if(mode==="native_success")nativeRows.push({...nativeError,uuid:normalUUID,parentUuid:errorUUID,isApiErrorMessage:false,error:undefined,message:{id:normalId,role:"assistant",content:[]}});
  const nativeText=nativeRows.map(row=>JSON.stringify(row)).join("\n")+"\n";
  f.host.claude=vi.fn(async input=>parseClaudeQuota(nativeText,input));
  f.start();await f.end();return f;
 }
 it("continues when rewritten client user ID differs from native user UUID but terminal assistant ID matches",async()=>{
  const f=await run("match");expect(f.host.send).toHaveBeenCalledTimes(1);
  expect(f.host.claude).toHaveBeenCalledWith(expect.objectContaining({messageId:terminalId,sessionId:nativeSession}));
  expect((await f.ledger.read())[0]).toMatchObject({errorId:errorUUID,userId:nativeUser,state:"finished"});
 });
 it.each(["normal","missing","foreign","native_success"] as const)("never looks back to an earlier error for %s terminal evidence",async mode=>{
  const f=await run(mode);expect(f.host.send).not.toHaveBeenCalled();expect(f.host.refresh).not.toHaveBeenCalled();
  if(mode==="missing"||mode==="foreign")expect(f.host.claude).not.toHaveBeenCalled();
 });
});

describe("durable continuation ledger",()=>{
 it("writes private atomic records and poisons unfinished intents across a reload",async()=>{
  const root=await mkdtemp(join(tmpdir(),"continuation-ledger-"));roots.push(root);
  const ledger=new ContinuationLedger(root),f=fixture("claude",false,ledger);f.start();await f.end();
  const records=await ledger.read(),file=join(root,"continuation-ledger.json");
  expect((await stat(file)).mode&0o777).toBe(0o600);
  const contents=await readFile(file,"utf8");expect(contents).not.toContain("Continue.");expect(contents).not.toContain("/profiles/");
  const next=new ContinuationLedger(root);expect((await next.read())[0]).toMatchObject({key:records[0].key,state:"uncertain"});
  expect(await next.add(records[0])).toBe(false);
 });
 it("rejects damaged journals instead of silently resetting deduplication",async()=>{
  const root=await mkdtemp(join(tmpdir(),"continuation-ledger-"));roots.push(root);await writeFile(join(root,"continuation-ledger.json"),'{}');
  await expect(new ContinuationLedger(root).read()).rejects.toThrow(/journal/);
 });
});

// These observations are synthetic SDK callbacks, never real agents/providers.
describe("owned live Claude observation",()=>{
 function observedFixture(){
  const f=fixture();
  const listeners=new Set<(event:any)=>void>(),updates=new Set<(event:any)=>void>();
  const releases=vi.fn(async()=>{}),directoryRelease=vi.fn(async()=>{});
  let directoryCallbacks:any;
  const snapshot=()=>({...structuredClone(f.view.agent),runtimeInfo:{model:f.view.agent.model},persistence:{sessionId:f.view.agent.sessionId},activeTurn:f.view.agent.activeTurn?{turnId:f.view.agent.activeTurnId,startedAt:at}:null});
  const handle={refresh:vi.fn(async()=>({agent:snapshot()})),subscribe:vi.fn((cb:any)=>{updates.add(cb);return()=>updates.delete(cb);}),timeline:{subscribe:vi.fn((cb:any)=>{listeners.add(cb);return{ready:Promise.resolve(),release:async()=>{listeners.delete(cb);await releases();}};})}};
  const directory={ready:Promise.resolve({}),subscribe:vi.fn((cb:any)=>{directoryCallbacks=cb;return()=>{};}),release:directoryRelease};
  const api={agents:{ref:()=>handle,list:vi.fn(async()=>({entries:[{agent:snapshot()}],pageInfo:{hasMore:false},subscription:directory}))}} as unknown as PaseoApi;
  const observer=new ContinuationObservation(f.coordinator,1);
  f.host.permitsRecovery=(p,id)=>observer.permitsRecovery(p,id);
  const emit=(event:any)=>{for(const cb of [...listeners])cb({agentId:"agent",timestamp:new Date(f.host.now()+10).toISOString(),event});};
  const update=()=>{for(const cb of [...updates])cb({kind:"upsert",agent:snapshot()});};
  const assistant=(id="msg_native_terminal",turnId?:string)=>emit({type:"timeline",provider:"claude",turnId,item:{type:"assistant_message",messageId:id,text:"synthetic"}});
  return{...f,api,observer,emit,update,assistant,handle,releases,directoryRelease,listeners,snapshot,directory:()=>directoryCallbacks};
 }
 const tick=async()=>{await new Promise(resolve=>setTimeout(resolve,8));};
 it("recovers a live background quota without hooks, through queued bookkeeping, only once",async()=>{
  const f=observedFixture();
  const session="e5f4ce10-01a8-4530-873b-cc22fd2b72cc",user="22734bb1-41bf-4967-96d6-ef975c569ad7",error="952db731-1f51-4fad-a320-f34af039c7bf",queued="6b4f701c-af83-4ed1-9ffd-b5c4da55a2bc";
  f.view.agent.sessionId=session;
  const rows=[{type:"user",uuid:user,parentUuid:null,turnOrigin:"task_notification",sessionId:session,timestamp:new Date(NOW-1000).toISOString(),message:{role:"user",content:"synthetic"}},
   {type:"assistant",uuid:error,parentUuid:user,sessionId:session,timestamp:new Date(NOW+5).toISOString(),isApiErrorMessage:true,error:"rate_limit",message:{id:"msg_native_terminal",role:"assistant"}},
   {type:"user",uuid:queued,parentUuid:error,sessionId:session,timestamp:new Date(NOW+26).toISOString(),queueTranscriptOnly:true,promptSource:"system",origin:{kind:"task-notification",producer:"session-task"},queueSkipAttachments:true,message:{role:"user",content:"synthetic"}}];
  vi.mocked(f.host.claude).mockImplementation(async input=>parseClaudeQuota(rows.map(r=>JSON.stringify(r)).join("\n")+"\n",input));
  await f.observer.ensure(f.api);
  vi.mocked(f.host.switch).mockImplementation(async(_p,_id,target,op)=>{
   await op.guard("beforeReload");f.coordinator.closed("agent");f.view.agent.status="closed";f.update();
   f.emit({type:"thread_started",provider:"claude",sessionId:session});await op.guard("afterReload");
   f.view.agent.status="idle";await op.guard("afterReceipt");f.view.accountId=target;await op.afterConfirmed();
  });
  f.setNow(NOW+20);f.assistant();await tick();f.assistant();await tick();
  expect(f.host.claudeMessageId).not.toHaveBeenCalled();expect(f.host.refresh).toHaveBeenCalledTimes(1);expect(f.host.send).toHaveBeenCalledTimes(1);
  expect((await f.ledger.read())[0]).toMatchObject({state:"finished",errorId:error});
  await f.observer.stop();expect(f.releases).toHaveBeenCalled();expect(f.directoryRelease).toHaveBeenCalledTimes(1);
 });
 it("keeps canceled execution disarmed despite a late fresh error until explicit new input",async()=>{
  const f=observedFixture();await f.observer.ensure(f.api);
  f.emit({type:"turn_canceled",provider:"claude"});f.update();await tick();
  f.setNow(NOW+100);f.assistant();await tick();expect(f.host.send).not.toHaveBeenCalled();
  f.emit({type:"thread_started",provider:"claude",sessionId:"native"});f.assistant();await tick();expect(f.host.send).not.toHaveBeenCalled();
  f.emit({type:"timeline",provider:"claude",item:{type:"user_message",messageId:"autonomous-user"}});await tick();f.assistant("late-user-error");await tick();expect(f.host.send).not.toHaveBeenCalled();
  f.emit({type:"turn_started",provider:"claude",turnId:"autonomous"});await tick();f.assistant("late-error","autonomous");await tick();expect(f.host.send).not.toHaveBeenCalled();
  f.view.agent.lastUserMessageAt=new Date(NOW+100).toISOString();f.update();f.emit({type:"timeline",provider:"claude",item:{type:"user_message",messageId:"external-user"}});await tick();f.assistant("new-error","new");await tick();expect(f.host.send).toHaveBeenCalledTimes(1);await f.observer.stop();
 });
 it.each(["replacement","subscription_restored","error","directory_snapshot","directory_error","close"])("keeps the stop tombstone through a new Entry after %s",async transition=>{
  const f=observedFixture();await f.observer.ensure(f.api);f.emit({type:"turn_canceled",provider:"claude"});
  if(transition==="directory_snapshot")f.directory().snapshot({entries:[{agent:f.snapshot()}]});
  else if(transition==="directory_error"){f.directory().error(new Error("synthetic"));await f.observer.ensure(f.api);}
  else if(transition==="close"){f.view.agent.status="closed";f.update();f.view.agent.status="idle";f.directory().update({type:"agent_update",payload:{kind:"upsert",agent:f.snapshot()}});}
  else f.emit({type:transition,epoch:2,error:"synthetic"});
  await tick();f.setNow(NOW+100);f.assistant("late-after-rebuild");await tick();
  expect(f.handle.timeline.subscribe).toHaveBeenCalledTimes(2);expect(f.host.claude).not.toHaveBeenCalled();expect(f.host.send).not.toHaveBeenCalled();
  f.view.agent.lastUserMessageAt=new Date(NOW+101).toISOString();f.update();await tick();f.assistant("new-input-error");await tick();expect(f.host.send).toHaveBeenCalledTimes(1);await f.observer.stop();
 });
 it("shares the user-stop gate with foreground hooks and autonomous SDK turn events",async()=>{
  const f=observedFixture();f.view.agent.sessionId="bed6b174-dab0-4c3d-b6a2-17d41eb7ab32";
  vi.mocked(f.host.claude).mockImplementation(async input=>parseClaudeQuota([
   {type:"user",uuid:"5a15cc3f-bb1c-4c31-beca-70231044f091",parentUuid:null,sessionId:input.sessionId,timestamp:new Date(NOW-1).toISOString(),message:{role:"user",content:"synthetic"}},
   {type:"assistant",uuid:"e24547ef-ea4f-44d3-b0a9-55b3ffbfbac5",parentUuid:"5a15cc3f-bb1c-4c31-beca-70231044f091",sessionId:input.sessionId,timestamp:new Date(NOW).toISOString(),isApiErrorMessage:true,error:"rate_limit",message:{id:input.messageId}}
  ].map(row=>JSON.stringify(row)).join("\n")+"\n",input));
  await f.observer.ensure(f.api);
  f.observer.canceled("agent");f.event.outcome={kind:"canceled"};await f.end();
  f.event.outcome={kind:"completed"};f.start();f.emit({type:"turn_started",provider:"claude",turnId:"turn"});
  f.assistant("msg_native_terminal","turn");await f.end();await tick();expect(f.host.switch).not.toHaveBeenCalled();expect(f.host.send).not.toHaveBeenCalled();
  f.view.agent.lastUserMessageAt=new Date(NOW+1).toISOString();f.update();f.start();
  await f.end();expect(f.host.switch).toHaveBeenCalledTimes(1);expect(f.host.send).toHaveBeenCalledTimes(1);await f.observer.stop();
 });
 it("holds a hook cancellation received before discovery through the first snapshot",async()=>{
  const f=observedFixture();f.observer.canceled("agent");f.observer.canceled("agent");
  await f.observer.ensure(f.api);f.assistant("late-after-hook");await tick();expect(f.host.claude).not.toHaveBeenCalled();expect(f.host.send).not.toHaveBeenCalled();
  f.view.agent.lastUserMessageAt=new Date(NOW+1).toISOString();f.update();await tick();f.assistant("fresh-input-error");await tick();expect(f.host.send).toHaveBeenCalledTimes(1);await f.observer.stop();
 });
 it("rejects a rebroadcast native error older than the armed baseline",async()=>{
  const f=observedFixture();const session="2898bff3-0ef9-4bd6-9796-dd72775741a5",user="f0582817-f5f7-48b5-a414-aefc85852517",error="d1fb2088-87ee-4ea2-9745-b1937c448cec";f.view.agent.sessionId=session;
  const rows=[{type:"user",uuid:user,parentUuid:null,sessionId:session,timestamp:new Date(NOW-10).toISOString(),message:{role:"user",content:"synthetic"}},{type:"assistant",uuid:error,parentUuid:user,sessionId:session,timestamp:new Date(NOW-1).toISOString(),isApiErrorMessage:true,error:"rate_limit",message:{id:"old-error"}}];
  vi.mocked(f.host.claude).mockImplementation(async input=>parseClaudeQuota(rows.map(r=>JSON.stringify(r)).join("\n")+"\n",input));
  await f.observer.ensure(f.api);f.assistant("old-error");await tick();expect(f.host.refresh).not.toHaveBeenCalled();expect(f.host.send).not.toHaveBeenCalled();await f.observer.stop();
 });
 it("snapshots/history and ordinary assistants never refresh quota",async()=>{
  const f=observedFixture();vi.mocked(f.host.claude).mockResolvedValue(null);
  await f.observer.ensure(f.api);await tick();expect(f.host.claude).not.toHaveBeenCalled();
  f.assistant();await tick();expect(f.host.claude).toHaveBeenCalledTimes(1);expect(f.host.refresh).not.toHaveBeenCalled();await f.observer.stop();
 });
 it.each(["user","permission","turn","snapshot_turn","model","session","archive"])("cancels pending evidence for %s activity",async kind=>{
  const f=observedFixture();await f.observer.ensure(f.api);f.assistant();
  if(kind==="user")f.emit({type:"timeline",provider:"claude",item:{type:"user_message",messageId:"new-user"}});
  if(kind==="permission")f.emit({type:"permission_requested"});
  if(kind==="turn")f.emit({type:"turn_started",provider:"claude",turnId:"new"});
  if(kind==="snapshot_turn"){f.view.agent.activeTurn=true;f.view.agent.activeTurnId="different";f.view.agent.status="running";f.update();}
  if(kind==="model")f.view.agent.model="new";
  if(kind==="session")f.view.agent.sessionId="new";
  if(kind==="archive")f.view.agent.archived=true;
  if(["model","session","archive"].includes(kind))f.update();
  await tick();expect(f.host.send).not.toHaveBeenCalled();await f.observer.stop();
 });
 it("reconnect discards candidates, establishes a fresh ready and accepts only future callbacks",async()=>{
  const f=observedFixture();await f.observer.ensure(f.api);f.assistant();f.emit({type:"subscription_restored"});await tick();
  expect(f.host.send).not.toHaveBeenCalled();expect(f.handle.timeline.subscribe).toHaveBeenCalledTimes(2);
  f.assistant();await tick();expect(f.host.send).toHaveBeenCalledTimes(1);await f.observer.stop();
 });
 it("preserves its own same-session thread start through reload and records accepted send once",async()=>{
  const f=observedFixture();await f.observer.ensure(f.api);
  vi.mocked(f.host.switch).mockImplementation(async(_p,_id,target,op)=>{
   await op.guard("beforeReload");f.coordinator.closed("agent");f.view.agent.status="closed";f.update();
   f.emit({type:"thread_started",provider:"claude",sessionId:"native"});
   await op.guard("afterReload");f.view.agent.status="idle";await op.guard("afterReceipt");f.view.accountId=target;await op.afterConfirmed();
  });
  vi.mocked(f.host.send).mockImplementation(async()=>{f.emit({type:"turn_started",provider:"claude",turnId:"own-continuation"});});
  f.assistant();await tick();expect(f.host.send).toHaveBeenCalledTimes(1);expect((await f.ledger.read())[0].state).toBe("finished");
  f.assistant();await tick();expect(f.host.send).toHaveBeenCalledTimes(1);await f.observer.stop();
 });
 it("rearms after its accepted send starts a new turn before the RPC settles",async()=>{
  const f=observedFixture();await f.observer.ensure(f.api);
  vi.mocked(f.host.claude).mockImplementation(async input=>({errorId:input.messageId,userId:"synthetic-user"}));
  vi.mocked(f.host.send).mockImplementation(async()=>{
   f.view.agent.lastUserMessageAt=new Date(f.host.now()+1).toISOString();f.view.agent.status="running";f.view.agent.activeTurn=true;
   f.coordinator.started({...f.event,turnId:"continuation"},f.api);
   f.emit({type:"turn_started",provider:"claude",turnId:"continuation"});
   f.emit({type:"timeline",provider:"claude",turnId:"continuation",item:{type:"user_message",messageId:"own-user"}});f.update();
  });
  f.assistant("first-error");await tick();expect(f.host.send).toHaveBeenCalledTimes(1);
  f.view.agent.status="idle";f.view.agent.activeTurn=false;
  f.view.registry.accounts.push({...f.view.registry.accounts[1],id:"third",identityKey:"third",home:"/profiles/third"});
  f.setReadings([f.usage("source",10),f.usage("target",100),f.usage("third",10)]);
  // No fresh directory event: only the next live background assistant arrives.
  f.assistant("second-error");await tick();expect(f.host.send).toHaveBeenCalledTimes(2);expect(f.view.accountId).toBe("third");await f.observer.stop();
 });
 it("waits for a foreground running-to-idle transition without replacing its observation",async()=>{
  const f=observedFixture();f.view.agent.status="running";f.view.agent.activeTurn=true;f.view.agent.activeTurnId="turn";
  f.start();await f.observer.ensure(f.api);f.assistant("msg_native_terminal","turn");await tick();expect(f.host.send).not.toHaveBeenCalled();
  f.view.agent.status="idle";f.view.agent.activeTurn=false;f.update();await tick();expect(f.host.send).toHaveBeenCalledTimes(1);await f.end();expect(f.host.send).toHaveBeenCalledTimes(1);await f.observer.stop();
 });
 it("stop releases an in-flight ready subscription and never arms it later",async()=>{
  const f=observedFixture();let ready!:()=>void;
  const promise=new Promise<void>(resolve=>{ready=resolve;});
  vi.mocked(f.handle.timeline.subscribe).mockImplementation((cb:any)=>{f.listeners.add(cb);return{ready:promise,release:async()=>{f.listeners.delete(cb);f.releases();ready();}};});
  const start=f.observer.ensure(f.api);await tick();await f.observer.stop();await start;f.assistant();await tick();expect(f.host.send).not.toHaveBeenCalled();expect(f.releases).toHaveBeenCalled();
 });
});
