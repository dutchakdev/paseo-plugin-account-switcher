import { createHash, randomUUID } from "node:crypto";
import type { Provider, UsageSnapshot } from "../shared/contracts";
import { FAILOVER_KIND, type FailoverRow } from "../shared/failover";
import { explicitCodexQuota, recoveryDecision } from "./failover";
import type { PaseoApi } from "./paseo-api";
import type { Registry } from "./store";
import { SwitchRefusal, type RecoverySwitch } from "./switching";
import type { ContinuationOperation, OperationLedger } from "./continuation-ledger";

export interface RecoveryAgent {
 id:string;provider:string;cwd:string;model:string|null;sessionId:string|null;workspaceId:string|null;
 status:string;activeTurn:boolean;activeTurnId?:string|null;activeTurnStartedAt?:string|null;pendingPermissions:readonly unknown[]|null;archived:boolean;lastUserMessageAt:string|null;
}
export interface RecoveryView {agent:RecoveryAgent;accountId:string|null;registry:Registry}
export interface RecoveryEvent {agent:{id:string;provider:string;cwd:string;parentAgentId:string|null};turnId:string|null;outcome:{kind:string;error?:{code?:string;message:string}}}
export interface ContinuationHost {
 read(paseo:PaseoApi,id:string):Promise<RecoveryView|null>;
 refresh(paseo:PaseoApi):Promise<UsageSnapshot[]|null>;
 claudeMessageId(paseo:PaseoApi,id:string,turnId:string,check:()=>void):Promise<string|null>;
 claude(input:{configDir:string;cwd:string;sessionId:string;messageId:string;startedAt:number;endedAt:number}):Promise<{errorId:string;userId:string}|null>;
 switch(paseo:PaseoApi,id:string,target:string,operation:RecoverySwitch):Promise<unknown>;
 send(paseo:PaseoApi,id:string,messageId:string):Promise<void>;
 row(paseo:PaseoApi,id:string,row:FailoverRow):Promise<unknown>;
 now():number;
}
type Observed = {turnId:string;startedAt:number;generation:number;cwd:string;baseline:Promise<RecoveryView|null>};
type Context = {quota?:{usage:UsageSnapshot[];since:number};observed:Observed;base:RecoveryView;generation:number;targetGeneration:number|null;operation:ContinuationOperation;automatic:boolean};
const hash = (value:string) => createHash("sha256").update(value).digest("hex");
const HOUR=3_600_000, OFFER_TTL=600_000;
const unavailable=()=>new SwitchRefusal("This recovery offer is no longer safe to resume. Choose an account with /account instead.");

/** Turn evidence, durable at-most-once recovery and activity guards. No provider commands live here. */
export class ContinuationCoordinator {
 private stopped=false;
 private readonly generations=new Map<string,number>();
 private readonly observed=new Map<string,Observed>();
 private readonly contexts=new Map<string,Context>();
 private readonly active=new Set<string>();
 private readonly pending=new Set<Promise<unknown>>();
 // Only one close associated with this operation's native reload may be ignored.
 private readonly reloading=new Map<string,{key:string;closeObserved:boolean}>();
 constructor(private readonly ledger:OperationLedger,private readonly host:ContinuationHost){}
 invalidate(id:string):void{this.generations.set(id,(this.generations.get(id)??0)+1);this.observed.delete(id);for(const [row,c] of this.contexts)if(c.operation.agentId===id)this.contexts.delete(row);}
 closed(id:string):void{
  const own=this.reloading.get(id);
  if(own&&!own.closeObserved){own.closeObserved=true;return;}
  this.invalidate(id);
 }
 started(event:Pick<RecoveryEvent,"agent"|"turnId">,paseo:PaseoApi):void{
  this.invalidate(event.agent.id);
  if(this.stopped||!event.turnId||!["claude","codex"].includes(event.agent.provider))return;
  // Set the clock and generation synchronously: turn.before is a notification, not a waiting hook.
  const startedAt=this.host.now(),generation=this.generations.get(event.agent.id)!;
  const baseline=this.host.read(paseo,event.agent.id).catch(()=>null);
  this.observed.set(event.agent.id,{turnId:event.turnId,startedAt,generation,cwd:event.agent.cwd,baseline});
 }
 activity(id:string,agent:RecoveryAgent):void{
  if(!this.active.has(id)&&![...this.contexts.values()].some(c=>c.operation.agentId===id))return;
  const observed=this.observed.get(id);if(!observed)return;
  const context=[...this.contexts.values()].find(c=>c.operation.agentId===id&&c.generation===observed.generation);
  void (context?Promise.resolve(context.base):observed.baseline).then(base=>{
   if(this.observed.get(id)!==observed||!base)return;
   if(!this.sameAgent(base.agent,agent)||agent.archived||agent.activeTurn||agent.pendingPermissions?.length||(!this.reloading.has(id)&&agent.status==="closed"))this.invalidate(id);
  });
 }
 private alive(id:string,generation:number):void{
  if(this.stopped||this.generations.get(id)!==generation)throw unavailable();
 }
 private safe(view:RecoveryView|null,opening=false):view is RecoveryView {
  const a=view?.agent;
  return !!a&&(opening?["idle","error","initializing","closed"]:["idle","error"]).includes(a.status)&&!a.activeTurn&&Array.isArray(a.pendingPermissions)&&a.pendingPermissions.length===0&&!a.archived&&!!a.sessionId&&!!a.model&&!!a.cwd&&!!a.workspaceId&&!!a.lastUserMessageAt;
 }
 private sameAgent(base:RecoveryAgent,live:RecoveryAgent):boolean{
  return base.id===live.id&&base.provider===live.provider&&base.cwd===live.cwd&&base.model===live.model&&base.workspaceId===live.workspaceId&&base.lastUserMessageAt===live.lastUserMessageAt&&(!base.sessionId||base.sessionId===live.sessionId);
 }
 private account(view:RecoveryView,id:string){return view.registry.accounts.find(a=>a.id===id);}
 private async check(paseo:PaseoApi,c:Context,target=false,opening=false):Promise<RecoveryView>{
  const op=c.operation;this.alive(op.agentId,c.generation);
  const live=await this.host.read(paseo,op.agentId);this.alive(op.agentId,c.generation);
  if(!this.safe(live,opening)||!this.sameAgent(c.base.agent,live.agent)||live.agent.sessionId!==op.sessionId||!live.registry.integration.enabled||!live.registry.integration.providers.includes(op.provider)||(c.automatic&&!live.registry.autoFailover[op.provider]))throw unavailable();
  const source=this.account(live,op.fromId),destination=op.toId?this.account(live,op.toId):null;
  if(!source?.identityKey||source.generation!==this.account(c.base,op.fromId)?.generation||source.home!==this.account(c.base,op.fromId)?.home||hash(source.identityKey)!==op.fromIdentity||source.loginToken||source.authStatus!=="ready")throw unavailable();
  if(op.toId&&(!destination?.identityKey||destination.provider!==op.provider||destination.generation!==c.targetGeneration||destination.home!==this.account(c.base,op.toId!)?.home||hash(destination.identityKey)!==op.toIdentity||destination.loginToken||destination.authStatus!=="ready"))throw unavailable();
  if(live.accountId!==(target?op.toId:op.fromId))throw unavailable();
  const binding=live.registry.bindings.find(b=>b.agentId===op.agentId);
  if(binding){
   if(binding.pendingAccountId&&binding.pendingAccountId!==op.toId)throw unavailable();
   if(binding.status==="error"||(!this.active.has(op.agentId)&&binding.status==="switching"))throw unavailable();
   if(target&&(binding.status!=="ready"||binding.launchToken||binding.pendingAccountId))throw unavailable();
  }
  if(c.quota){
   const decision=recoveryDecision({currentId:op.fromId,accounts:live.registry.accounts.filter(a=>!op.toId||a.id===op.fromId||a.id===op.toId),usage:c.quota.usage,model:live.agent.model,now:this.host.now(),since:c.quota.since});
   if(!decision||(op.toId&&(decision.kind!=="offer"||decision.toId!==op.toId)))throw unavailable();
  }
  return live;
 }
 private track<T>(promise:Promise<T>):Promise<T>{this.pending.add(promise);void promise.finally(()=>this.pending.delete(promise)).catch(()=>{});return promise;}
 ended(event:RecoveryEvent,paseo:PaseoApi):Promise<void>{
  const id=event.agent.id,observed=this.observed.get(id),endedAt=this.host.now();
  if(event.outcome.kind==="canceled"){this.invalidate(id);return Promise.resolve();}
  if(this.stopped||!observed||!event.turnId||observed.turnId!==event.turnId||this.active.has(id))return Promise.resolve();
  if(event.agent.provider==="codex"&&!explicitCodexQuota(event.outcome))return Promise.resolve();
  if(event.agent.provider!=="codex"&&!(event.agent.provider==="claude"&&["completed","failed"].includes(event.outcome.kind)))return Promise.resolve();
  this.active.add(id);
  return this.track(this.examine(event,paseo,observed,endedAt).catch(()=>{/* Unknown state must not recover. */}).finally(()=>{this.active.delete(id);this.reloading.delete(id);}));
 }
 private async examine(event:RecoveryEvent,paseo:PaseoApi,observed:Observed,endedAt:number):Promise<void>{
  const id=event.agent.id;this.alive(id,observed.generation);
  const started=await observed.baseline;this.alive(id,observed.generation);
  const actualStart=started?.agent.activeTurnStartedAt?Date.parse(started.agent.activeTurnStartedAt):NaN;
  if(started?.agent.activeTurnId===event.turnId&&Number.isFinite(actualStart)&&actualStart>0&&actualStart<=observed.startedAt+1000)observed.startedAt=actualStart;
  const live=await this.host.read(paseo,id);this.alive(id,observed.generation);
  if(!started||!this.safe(live)||!this.sameAgent(started.agent,live.agent)||observed.cwd!==live.agent.cwd||started.accountId!==live.accountId||!live.accountId||!live.registry.integration.enabled||!live.registry.integration.providers.includes(live.agent.provider as Provider))return;
  const source=this.account(live,live.accountId),startedSource=started.accountId?this.account(started,started.accountId):null;
  if(!source?.identityKey||source.generation!==startedSource?.generation||source.identityKey!==startedSource.identityKey||source.loginToken||source.authStatus!=="ready"||source.provider!==event.agent.provider)return;
  const key=JSON.stringify([id,live.agent.sessionId,event.turnId]),rowId=`${FAILOVER_KIND}-${hash(key)}`;
  let records=await this.ledger.read();this.alive(id,observed.generation);
  if(records.some(op=>op.key===key))return;
  let evidence:{errorId:string;userId:string}|null=null;
  if(source.provider==="claude"){
   const nativeMessageId=await this.host.claudeMessageId(paseo,id,event.turnId!,()=>this.alive(id,observed.generation));this.alive(id,observed.generation);
   // The terminal assistant ID is bound to this Paseo turn, then to the native terminal error and parent chain.
   const current=await this.host.read(paseo,id);this.alive(id,observed.generation);
   if(!nativeMessageId||!this.safe(current)||!this.sameAgent(live.agent,current.agent)||current.accountId!==source.id)return;
   evidence=await this.host.claude({configDir:source.home,cwd:live.agent.cwd,sessionId:live.agent.sessionId!,messageId:nativeMessageId,startedAt:observed.startedAt,endedAt});
   this.alive(id,observed.generation);
   if(!evidence)return;
  }
  const placeholder:ContinuationOperation={key,rowId,agentId:id,sessionId:live.agent.sessionId!,turnId:event.turnId!,provider:source.provider,fromId:source.id,toId:null,fromIdentity:hash(source.identityKey),toIdentity:null,createdAt:this.host.now(),updatedAt:this.host.now(),attemptedAt:null,state:"intent",messageId:randomUUID(),resumes:true,resetsAt:null,errorId:evidence?.errorId??null,userId:evidence?.userId??null};
  const c:Context={observed,base:live,generation:observed.generation,targetGeneration:null,operation:placeholder,automatic:live.registry.autoFailover[source.provider]};
  await this.check(paseo,c);
  const since=this.host.now(),usage=await this.host.refresh(paseo);await this.check(paseo,c);
  if(!usage)return;
  c.quota={usage,since};
  records=await this.ledger.read();await this.check(paseo,c);
  const recent=records.filter(op=>op.agentId===id&&op.attemptedAt!==null&&this.host.now()-op.attemptedAt<HOUR);
  const excluded=live.registry.accounts.filter(a=>a.identityKey&&recent.some(op=>op.fromIdentity===hash(a.identityKey!))).map(a=>a.identityKey!);
  const decision=recoveryDecision({currentId:source.id,accounts:live.registry.accounts,usage,model:live.agent.model,now:this.host.now(),since,excludedIdentities:excluded});
  if(!decision)return;
  const target=decision.kind==="offer"?live.registry.accounts.find(a=>a.id===decision.toId):null;
  c.operation={...placeholder,toId:target?.id??null,toIdentity:target?.identityKey?hash(target.identityKey):null,resetsAt:decision.resetsAt};
  c.targetGeneration=target?.generation??null;
  if(!target||recent.length>=3){
   c.operation.state="finished";c.operation.toId=null;c.operation.toIdentity=null;
   if(await this.ledger.add(c.operation))await this.host.row(paseo,id,this.row(c,"none"));
   return;
  }
  if(!await this.ledger.add(c.operation))return;
  this.contexts.set(rowId,c);
  await this.check(paseo,c);
  if(c.automatic)await this.perform(paseo,c,false);
  else{await this.host.row(paseo,id,this.row(c,"offered"));await this.check(paseo,c);}
 }
 private row(c:Context,state:FailoverRow["state"],error:string|null=null):FailoverRow{
  const op=c.operation;
  return{rowId:op.rowId,state,from:this.account(c.base,op.fromId)?.label??"Previous account",fromId:op.fromId,to:op.toId?this.account(c.base,op.toId)?.label??null:null,toId:op.toId,resetsAt:op.resetsAt,error,resumes:op.resumes};
 }
 async apply(paseo:PaseoApi,input:{agentId:string;accountId:string;rowId:string;fromId?:string}):Promise<void>{
  if(this.stopped||this.active.has(input.agentId))throw unavailable();
  const c=this.contexts.get(input.rowId);
  if(!c||c.operation.agentId!==input.agentId||c.operation.toId!==input.accountId||(input.fromId&&input.fromId!==c.operation.fromId)||this.host.now()-c.operation.createdAt>OFFER_TTL)throw unavailable();
  this.active.add(input.agentId);
  c.quota=undefined;
  try{
   const record=(await this.ledger.read()).find(item=>item.key===c.operation.key);
   this.alive(input.agentId,c.generation);
   if(record?.state!=="intent")throw unavailable();
   await this.track(this.perform(paseo,c,true));
  }
  finally{this.active.delete(input.agentId);this.reloading.delete(input.agentId);}
 }
 private async perform(paseo:PaseoApi,c:Context,refresh:boolean):Promise<void>{
  const op=c.operation;
  try{
   await this.check(paseo,c);
   const records=await this.ledger.read();await this.check(paseo,c);
   const stored=records.find(item=>item.key===op.key);
   if(stored?.state!=="intent"||!op.toId)throw unavailable();
   const recent=records.filter(item=>item.agentId===op.agentId&&item.attemptedAt!==null&&this.host.now()-item.attemptedAt<HOUR);
   if(recent.length>=3||recent.some(item=>item.fromIdentity===op.toIdentity))throw unavailable();
   // Re-read both source and candidates for a delayed button; automatic decisions just refreshed them.
   if(refresh){
    const since=this.host.now(),usage=await this.host.refresh(paseo),live=await this.check(paseo,c);
    const decision=usage?recoveryDecision({currentId:op.fromId,accounts:live.registry.accounts,usage,model:live.agent.model,now:this.host.now(),since}):null;
    if(decision?.kind!=="offer"||decision.toId!==op.toId)throw unavailable();
    c.quota={usage:usage!,since};
   }
   await this.ledger.update(op.key,"switching",this.host.now());await this.check(paseo,c);
   await this.host.row(paseo,op.agentId,this.row(c,"switching"));await this.check(paseo,c);
   await this.host.switch(paseo,op.agentId,op.toId,{
    guard:async stage=>{
     // A just-reloaded process may still be opening; only this owned boundary permits known transient statuses.
     // Receipt and send guards below always require idle/error again.
     await this.check(paseo,c,false,stage==="afterReload"&&this.reloading.get(op.agentId)?.key===op.key);
     if(stage==="beforeReload"&&!this.reloading.has(op.agentId))this.reloading.set(op.agentId,{key:op.key,closeObserved:false});
    },
    afterConfirmed:async()=>{
     this.reloading.delete(op.agentId);
     await this.check(paseo,c,true);
     await this.ledger.update(op.key,"sending",this.host.now());
     // Paseo 0.15.4 has no atomic idle-CAS send. The last RPC gap remains; never retry an ambiguous send.
     await this.check(paseo,c,true);
     await this.host.send(paseo,op.agentId,op.messageId);
     await this.ledger.update(op.key,"finished",this.host.now());
     await this.host.row(paseo,op.agentId,this.row(c,c.automatic?"auto":"switched"));
    },
   });
  }catch(error){
   await this.ledger.update(op.key,"uncertain",this.host.now());
   await this.host.row(paseo,op.agentId,this.row(c,"failed",error instanceof SwitchRefusal?error.message:"Recovery stopped; use /account to inspect the session."));
   throw error;
  }
 }
 async stop():Promise<void>{this.stopped=true;for(const id of this.observed.keys())this.invalidate(id);await Promise.allSettled([...this.pending]);this.contexts.clear();this.reloading.clear();}
}
