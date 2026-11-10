import type { PaseoApi } from "./paseo-api";
import { ContinuationCoordinator, type RecoveryAgent, type RecoveryBaseline } from "./continuation";

type Handle=ReturnType<PaseoApi["agents"]["ref"]>;
type Snapshot=NonNullable<Awaited<ReturnType<Handle["refresh"]>>>["agent"];
type Timeline=ReturnType<Handle["timeline"]["subscribe"]>;
type Event=Parameters<Parameters<Handle["timeline"]["subscribe"]>[0]>[0];
type Directory=NonNullable<Awaited<ReturnType<PaseoApi["agents"]["list"]>>["subscription"]>;
type Candidate={messageId:string;turnId:string|null;at:number};
type Entry={id:string;handle:Handle;serial:number;disposed:boolean;timeline:Timeline|null;remove:(()=>void)|null;baseline:RecoveryBaseline|null;candidate:Candidate|null;timer:ReturnType<typeof setTimeout>|null;latest:RecoveryAgent|null;checking:boolean;ready:boolean;arming:number|null};
export const recoveryAgent=(a:Snapshot):RecoveryAgent=>({id:a.id,provider:a.provider,cwd:a.cwd,model:a.runtimeInfo?.model||a.model||null,sessionId:a.persistence?.sessionId??null,workspaceId:a.workspaceId??null,status:a.status,activeTurn:!!a.activeTurn,activeTurnId:a.activeTurn?.turnId??null,activeTurnStartedAt:a.activeTurn?.startedAt??null,pendingPermissions:Array.isArray(a.pendingPermissions)?a.pendingPermissions:null,archived:!!a.archivedAt,lastUserMessageAt:a.lastUserMessageAt??null});

/** Owns only live SDK observations. Initial/restored snapshots establish context,
 * never candidates. No history/refetch is used to recover an unobserved error. */
export class ContinuationObservation {
 private stopped=false;
 private epoch=0;
 private paseo:PaseoApi|null=null;
 private starting:Promise<void>|null=null;
 private directory:Directory|null=null;
 private removeDirectory:(()=>void)|null=null;
 private readonly entries=new Map<string,Entry>();
 // A user stop outlives disposable timeline/directory handles. No persistence
 // across plugin lifetimes: the host supplies no durable last-stop marker.
 private readonly stops=new Map<string,{sessionId:string|null;userAt:string|null}>();
 private readonly pending=new Set<Promise<unknown>>();
 private readonly lifetime=new AbortController();
 private readonly removeSettled:()=>void;
 constructor(private readonly coordinator:ContinuationCoordinator,private readonly delayMs=250){
  this.removeSettled=coordinator.onSettled(id=>{const entry=this.entries.get(id);if(entry&&!entry.checking)this.refreshAgent(id,false);});
 }
 private track<T>(p:Promise<T>):Promise<T>{this.pending.add(p);void p.finally(()=>this.pending.delete(p)).catch(()=>{});return p;}
 ensure(paseo:PaseoApi):Promise<void>{
  if(this.stopped||this.directory)return Promise.resolve();
  if(this.starting)return this.starting;
  this.paseo=paseo;const epoch=++this.epoch;
  const start=(async()=>{
   const list=await paseo.agents.list({subscribe:{},filter:{includeArchived:false,includeBackground:true},page:{limit:200},signal:this.lifetime.signal});
   if(this.stopped||epoch!==this.epoch){await list.subscription.release();return;}
   this.directory=list.subscription;
   const sync=(snap:Pick<typeof list,"entries">)=>{if(this.stopped||epoch!==this.epoch)return;for(const entry of snap.entries)this.update(entry.agent);};
   this.removeDirectory=list.subscription.subscribe({
    // A restored owned directory has a new snapshot; release old timelines and
    // require newly established ready promises, not an old resolved ready.
    snapshot:snap=>{if(this.stopped||epoch!==this.epoch)return;this.dropAll();sync(snap);},
    update:message=>{if(this.stopped||epoch!==this.epoch||message.type!=="agent_update")return;const update=message.payload;if(update.kind==="remove")this.drop(update.agentId);else this.update(update.agent);},
    error:()=>{if(epoch!==this.epoch)return;this.coordinator.diagnostic("","observer_directory_error");this.dropAll();this.removeDirectory?.();this.removeDirectory=null;this.directory=null;this.epoch++;void list.subscription.release().catch(()=>{});},
   });
   await list.subscription.ready;
   if(this.stopped||epoch!==this.epoch)return;
   sync(list);
   // Page the initial directory too; all candidates still come only from future
   // live callbacks after each timeline's ready + baseline boundary.
   let page=list.pageInfo,cursor=page.nextCursor;const cursors=new Set<string>();
   for(let n=0;page.hasMore&&cursor&&n<20;n++){
    if(cursors.has(cursor))break;cursors.add(cursor);
    const more=await paseo.agents.list({filter:{includeArchived:false,includeBackground:true},page:{limit:200,cursor},signal:this.lifetime.signal});
    if(this.stopped||epoch!==this.epoch)return;
    for(const entry of more.entries)this.update(entry.agent);
    page=more.pageInfo;cursor=page.nextCursor;
   }
   await Promise.allSettled([...this.pending]);
   this.coordinator.diagnostic("","observer_active");
  })().catch(()=>{if(!this.stopped)this.coordinator.diagnostic("","observer_setup_failed");}).finally(()=>{if(this.starting===start)this.starting=null;});
  this.starting=start;return start;
 }
 canceled(id:string):void{
  const entry=this.entries.get(id);
  if(!this.stops.has(id))this.stops.set(id,{sessionId:entry?.latest?.sessionId??null,userAt:entry?.latest?.lastUserMessageAt??null});
  if(entry)this.cancel(entry);else this.coordinator.invalidate(id);
 }
 async permitsRecovery(paseo:PaseoApi,id:string):Promise<boolean>{
  if(this.stopped)return false;
  if(!this.stops.has(id))return true;
  try{
   const result=await paseo.agents.ref(id).refresh();
   return !this.stopped&&!!result&&!this.suspended(recoveryAgent(result.agent));
  }catch{return false;}
 }
 private suspended(agent:RecoveryAgent|null):boolean{
  if(!agent)return true;
  const marker=this.stops.get(agent.id);if(!marker)return false;
  // A cancel received before discovery remains stopped when first discovered.
  // That first snapshot is a baseline, not evidence of a new external prompt.
  if(!marker.sessionId){marker.sessionId=agent.sessionId;marker.userAt=agent.lastUserMessageAt;return true;}
  if(agent.sessionId&&agent.sessionId!==marker.sessionId||agent.lastUserMessageAt&&marker.userAt&&Date.parse(agent.lastUserMessageAt)>Date.parse(marker.userAt)){
   this.stops.delete(agent.id);return false;
  }
  return true;
 }
 private valid(entry:Entry,serial?:number):boolean{return !this.stopped&&!entry.disposed&&this.entries.get(entry.id)===entry&&(serial===undefined||entry.serial===serial);}
 private cancel(entry:Entry,invalidate=true):void{
  entry.serial++;entry.baseline=null;entry.candidate=null;if(entry.timer)clearTimeout(entry.timer);entry.timer=null;
  if(invalidate)this.coordinator.invalidate(entry.id);
 }
 private drop(id:string):void{
  const entry=this.entries.get(id);if(!entry)return;this.entries.delete(id);entry.disposed=true;this.cancel(entry);entry.remove?.();entry.remove=null;
  if(entry.timeline){const timeline=entry.timeline;entry.timeline=null;this.track(timeline.release().catch(()=>{}));}
 }
 private dropAll():void{for(const id of [...this.entries.keys()])this.drop(id);}
 private update(snapshot:Snapshot):void{
  const a=recoveryAgent(snapshot),id=a.id;
  if(a.provider!=="claude"||a.archived||a.status==="closed"){
   if(a.status==="closed"&&this.coordinator.ownsReload(id)){const own=this.entries.get(id);if(own){own.candidate=null;if(own.timer)clearTimeout(own.timer);own.timer=null;}return;}
   this.drop(id);return;
  }
  let entry=this.entries.get(id);
  if(!entry){
   if(!this.paseo)return;
   entry={id,handle:this.paseo.agents.ref(id),serial:0,disposed:false,timeline:null,remove:null,baseline:null,candidate:null,timer:null,latest:a,checking:false,ready:false,arming:null};
   this.entries.set(id,entry);
   const e=entry;
   e.remove=e.handle.subscribe(update=>{if(update.kind==="remove")this.drop(id);else this.update(update.agent);});
   this.track(this.establish(e));return;
  }
  const previous=entry.latest;entry.latest=a;
  this.suspended(a);
  this.coordinator.activity(id,a);
  if(this.coordinator.isRecovering(id))return; // The coordinator's guards own its reload transition.
  const newTurn=a.activeTurn&&(!previous?.activeTurn||previous.activeTurnId!==a.activeTurnId)&&
   (!a.activeTurnId||entry.candidate?.turnId!==a.activeTurnId)&&!this.coordinator.endedTurn(id,a.activeTurnId);
  if(entry.baseline&&(newTurn||!this.coordinator.matches(entry.baseline,a)||a.pendingPermissions?.length)){
   this.cancel(entry);this.coordinator.diagnostic(id,"baseline_changed");this.track(this.arm(entry));return;
  }
  if(!entry.baseline&&entry.timeline)this.track(this.arm(entry));
  else if(entry.candidate&&!entry.timer&&previous?.activeTurn&&!a.activeTurn)this.schedule(entry);
 }
 private async establish(entry:Entry):Promise<void>{
  try{
   if(!this.valid(entry))return;
   const timeline=entry.handle.timeline.subscribe(event=>this.event(entry,event));entry.timeline=timeline;
   await timeline.ready;
   if(!this.valid(entry)){await timeline.release();return;}
   entry.ready=true;await this.arm(entry);
  }catch{if(this.valid(entry)){this.coordinator.diagnostic(entry.id,"observer_subscription_error");this.drop(entry.id);}}
 }
 private async arm(entry:Entry):Promise<void>{
  if(!this.valid(entry)||this.suspended(entry.latest)||!entry.timeline||!entry.ready||entry.arming===entry.serial||this.coordinator.isRecovering(entry.id))return;
  const serial=++entry.serial;entry.arming=serial;entry.baseline=null;
  try{
   const baseline=await this.coordinator.capture(this.paseo!,entry.id);
   if(!this.valid(entry,serial))return;
   entry.baseline=baseline;
   if(baseline)this.coordinator.diagnostic(entry.id,"observer_armed");
  }catch{if(this.valid(entry,serial))this.coordinator.diagnostic(entry.id,"baseline_changed");}
  finally{if(entry.arming===serial)entry.arming=null;}
 }
 refreshAgent(id:string,invalidate=true):void{
  const entry=this.entries.get(id);if(!entry){if(this.paseo&&!this.stopped)this.track(this.paseo.agents.ref(id).refresh().then(result=>{if(result&&!this.stopped)this.update(result.agent);}).catch(()=>{}));return;}
  this.cancel(entry,invalidate);if(entry.timeline)this.track(this.arm(entry));
 }
 private event(entry:Entry,message:Event):void{
  if(!this.valid(entry))return;
  const event=message.event;
  if(event.type==="replacement"||event.type==="error"||event.type==="subscription_restored"){
   this.coordinator.diagnostic(entry.id,"observer_disarmed");this.drop(entry.id);
   // A fresh subscription + baseline is required; its ready belongs to this
   // establishment. Never scan the missed range for replayable errors.
   if(!this.stopped&&this.paseo)this.track(entry.handle.refresh().then(result=>{if(result&&!this.stopped)this.update(result.agent);}).catch(()=>{}));
   return;
  }
  if(event.type==="thread_started"&&this.coordinator.ownsReload(entry.id)&&event.provider==="claude"&&event.sessionId===entry.baseline?.view.agent.sessionId)return;
  if(event.type==="turn_canceled"){
   this.canceled(entry.id);return;
  }
  if(this.suspended(entry.latest)&&(event.type==="turn_started"||event.type==="thread_started"||event.type==="timeline"&&event.item.type==="user_message")){
   // SDK user/turn events can also be autonomous notifications. Only a fresh
   // host user timestamp or different native session can release a user stop.
   this.track(entry.handle.refresh().then(result=>{if(result&&this.valid(entry))this.update(result.agent);}).catch(()=>{}));return;
  }
  if(event.type==="turn_started"||event.type==="permission_requested"||event.type==="thread_started"){
   this.refreshAgent(entry.id,event.type!=="turn_started"||!event.turnId||this.coordinator.currentTurn(entry.id)!==event.turnId);return;
  }
  if(event.type==="timeline"&&event.item.type==="user_message"){
   this.refreshAgent(entry.id,!event.turnId||this.coordinator.currentTurn(entry.id)!==event.turnId);return;
  }
  if(event.type!=="timeline"||event.provider!=="claude"||event.item.type!=="assistant_message"||!entry.baseline)return;
  const id=event.item.messageId;
  if(typeof id!=="string"||!id||id.length>512||/[\x00-\x20\x7f]/.test(id)){this.coordinator.diagnostic(entry.id,"anchor_missing");return;}
  const at="timestamp" in message?Date.parse(message.timestamp):NaN;
  if(!Number.isFinite(at)||at<entry.baseline.capturedAt)return;
  if(entry.candidate?.messageId!==id&&this.coordinator.isRecovering(entry.id)){this.refreshAgent(entry.id);return;}
  entry.candidate={messageId:id,turnId:event.turnId??null,at};this.schedule(entry);
 }
 private schedule(entry:Entry):void{
  if(!this.valid(entry)||!entry.baseline||!entry.candidate)return;
  if(entry.timer)clearTimeout(entry.timer);
  entry.timer=setTimeout(()=>{
   entry.timer=null;
   if(!this.valid(entry)||!entry.baseline||!entry.candidate||entry.checking)return;
   const candidate=entry.candidate,baseline=entry.baseline;entry.checking=true;
   this.track(this.coordinator.live(this.paseo!,baseline,candidate.messageId,candidate.turnId,candidate.at).finally(async()=>{
    entry.checking=false;
    if(!this.valid(entry))return;
    if(!entry.baseline){await this.arm(entry);return;}
    if(entry.baseline!==baseline)return;
    if(entry.candidate!==candidate){this.schedule(entry);return;}
    // A successful automatic switch changes the account without necessarily
    // changing the listing snapshot. Arm its new source before future errors.
    try{const fresh=await this.coordinator.capture(this.paseo!,entry.id);
     if(this.valid(entry)&&entry.baseline===baseline&&fresh&&fresh.view.accountId!==baseline.view.accountId){entry.baseline=fresh;entry.candidate=null;}
    }catch{/* Activity already invalidated this baseline. */}
   }));
  },this.delayMs);
 }
 async stop():Promise<void>{
  if(this.stopped)return;this.stopped=true;this.removeSettled();this.epoch++;this.lifetime.abort();this.dropAll();this.removeDirectory?.();this.removeDirectory=null;
  const directory=this.directory;this.directory=null;if(directory)await directory.release().catch(()=>{});
  await this.starting;await Promise.allSettled([...this.pending]);
 }
}
