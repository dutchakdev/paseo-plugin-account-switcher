import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as rpc from "./shared/contracts";
import { AccountController } from "./server/controller";
import { AutoFailoverGuard, extraUsageLeft, failoverDecision, mayBeUsedUp, nextResetAt } from "./server/failover";
import type { PaseoApi } from "./server/paseo-api";
import { registerPaseoUsage } from "./server/paseo-usage";
import { profileEnv } from "./server/session-env";
import { accountFrom, boundAccount, type Registry } from "./server/store";
import { SwitchRefusal } from "./server/switching";
import { appendAccountNote, appendFailoverRow } from "./server/timeline";
import { FAILOVER_KIND, type FailoverRow } from "./shared/failover";
import type { AccountNote } from "./shared/timeline";

// Paseo hands `agent.create`'s environment to the same agent's first `agent.session_open`, which alone knows the agent ID.
const MODEL_ENV="PASEO_ACCOUNT_SWITCHER_MODEL";
// Set by whoever creates the agent (e.g. `paseo run --env PASEO_ACCOUNT_SWITCHER_ACCOUNT=Work`): the account it starts on.
const ACCOUNT_ENV="PASEO_ACCOUNT_SWITCHER_ACCOUNT";
// The prompt that resumes an agent's work on the account it was switched to.
const CONTINUE="Continue.";
const reason=(error:unknown)=>error instanceof Error?error.message:String(error);
// What a failover row shows for a failure that is not one of the switch service's own refusals: their messages are
// written for the user, any other error's may carry paths or internals.
const SWITCH_FAILED="The switch failed; the plugin log has details.";

export default function contribute(server:PluginServerContext){
 const controller=new AccountController();
 // Notes are best effort: a failure while preparing one is logged and never changes the switch or the agent's creation.
 const note=async(agentId:string,make:()=>Promise<AccountNote|null>)=>{try{return await make();}catch(error){console.error(`Could not prepare the account note for agent ${agentId}: ${error instanceof Error?error.message:String(error)}`);return null;}};
 const labelOf=(state:Awaited<ReturnType<typeof controller.store.read>>,id:string|null|undefined)=>id?state.accounts.find(a=>a.id===id)?.label??null:null;
 // A new agent's note waits for `agent.created`: its timeline does not exist yet during session_open.
 // An agent whose creation fails never gets that event, so entries expire.
 const startNotes=new Map<string,{note:AccountNote;at:number}>();
 const NOTE_TTL=600_000;
 const guard=new AutoFailoverGuard();
 // Offers and automatic rotations are scoped to a live plugin instance. A rotation visits each account once, then
 // waits for a reset; a manual switch, cancellation, or setting change clears it.
 const offered=new Set<string>();
 const rotation=new Map<string,Set<string>>();
 const waiting=new Map<string,{paseo:PaseoApi;provider:"claude"|"codex";model:string|null;fromId:string;row:FailoverRow}>();
 const waitTimers=new Map<string,ReturnType<typeof setTimeout>>();
 const switching=new Set<string>();
 const clearRotation=(agentId:string)=>{rotation.delete(agentId);waiting.delete(agentId);const timer=waitTimers.get(agentId);if(timer){clearTimeout(timer);waitTimers.delete(agentId);}};
 server.handle(rpc.listAccounts,async(_,{paseo})=>controller.snapshot(paseo));
 server.handle(rpc.addAccount,async({provider,label},{paseo})=>{await controller.ensureRuntime(paseo);return controller.add(provider,label);});
 server.handle(rpc.renameAccount,async({accountId,label})=>{await controller.ready;return controller.store.change(r=>{const a=accountFrom(r,accountId);a.label=label;return rpc.AccountSchema.parse(a);});});
 server.handle(rpc.removeAccount,async({accountId},{paseo})=>{await controller.remove(accountId,paseo);return{};});
 server.handle(rpc.setFallback,async({provider,enabled})=>{await controller.ready;await controller.store.change(r=>{r.fallback[provider]=enabled;});return{};});
 server.handle(rpc.setDefaultAccount,async({provider,accountId},{paseo})=>{await controller.ensureRuntime(paseo);await controller.setDefault(provider,accountId);return{};});
 server.handle(rpc.startLogin,async({accountId,mode},{paseo})=>{await controller.ensureRuntime(paseo);return controller.startLogin(paseo,accountId,mode);});
 server.handle(rpc.getLoginStatus,async({accountId,sessionId})=>controller.getLoginStatus(accountId,sessionId));
 server.handle(rpc.submitLoginCode,async({accountId,sessionId,code})=>controller.submitLoginCode(accountId,sessionId,code));
 server.handle(rpc.checkLogin,async({accountId},{paseo})=>{await controller.ensureRuntime(paseo);return controller.finishLogin(accountId);});
 server.handle(rpc.cancelLogin,async({accountId,sessionId},{paseo})=>{await controller.ensureRuntime(paseo);return controller.cancelLogin(paseo,accountId,sessionId);});
 server.handle(rpc.prepareSwitch,async({agentId,accountId},{paseo})=>{await controller.ensureRuntime(paseo);return controller.switcher(paseo).prepare(agentId,accountId);});
 server.handle(rpc.applySwitch,async({agentId,accountId},{paseo})=>{
  await controller.ensureRuntime(paseo);
  // The registry as the agent left it: the note names the account from its binding.
  const before=await controller.store.read().catch(()=>null);
  const binding=await controller.switcher(paseo).apply(agentId,accountId);
  if(binding.currentAccountId){
   clearRotation(agentId);
   const to=binding.currentAccountId;
   void controller.usage.refresh(to).catch(()=>{});
   const switched=await note(agentId,async()=>{
    const state=await controller.store.read();
    const fromId=before?await controller.accountOf(paseo,agentId,binding.provider,before):null;
    const label=labelOf(state,to);
    return label?{kind:"switched",from:labelOf(state,fromId),to:label,reason:null}:null;
   });
   if(switched)void appendAccountNote(paseo,agentId,switched);
  }
  return binding;
 });
 // Applies a failover row's switch the way `/account` does: the same service checks the account, that the agent is idle
 // and has no pending permission, and the launch receipt. The row, not a separate note, tells the outcome, and a failure
 // is shown there before it is rethrown: a refusal by its message, anything else as SWITCH_FAILED, its detail logged.
 // "Continue." follows unless the row says the switch does not resume the agent.
 const switchOver=async(paseo:PaseoApi,agentId:string,row:FailoverRow,toId:string,done:"switched"|"auto")=>{
  // Claimed before any await. A second switch would only be refused by the service, and its row would cover the first one's.
  if(switching.has(agentId))throw new SwitchRefusal("An account switch is already in progress.");
  switching.add(agentId);
  try{
   await appendFailoverRow(paseo,agentId,{...row,state:"switching",error:null});
   try{
    await controller.ensureRuntime(paseo);
    // One step: a refusal before the switch starts leaves no selection the user never made.
    await controller.switcher(paseo).switchTo(agentId,toId);
   }catch(error){
    const refused=error instanceof SwitchRefusal;
    if(!refused)console.error(`Could not switch agent ${agentId} to account ${toId}: ${reason(error)}`);
    await appendFailoverRow(paseo,agentId,{...row,state:"failed",error:refused?error.message:SWITCH_FAILED});
    throw error;
   }
   void controller.usage.refresh(toId).catch(()=>{});
   await appendFailoverRow(paseo,agentId,{...row,state:done,error:null});
  }finally{switching.delete(agentId);}
  if(row.resumes===false)return;
  // The switch stands even if the prompt is not delivered; the chat is idle on the new account either way.
  await paseo.agents.ref(agentId).send(CONTINUE).catch(error=>console.error(`Could not ask agent ${agentId} to continue on the new account: ${reason(error)}`));
 };
 const scheduleWait=(paseo:PaseoApi,agentId:string,provider:"claude"|"codex",model:string|null,fromId:string,row:FailoverRow,at:string|null)=>{
  const previous=waitTimers.get(agentId);if(previous)clearTimeout(previous);
  waiting.set(agentId,{paseo,provider,model,fromId,row});
  if(!at)return;
  const delay=Math.min(2_147_000_000,Math.max(1_000,Date.parse(at)-Date.now()+1_000));
  const timer=setTimeout(()=>{void resumeWait(agentId);},delay);timer.unref?.();waitTimers.set(agentId,timer);
 };
 async function resumeWait(agentId:string){
  const pending=waiting.get(agentId);if(!pending)return;
  waiting.delete(agentId);waitTimers.delete(agentId);
  const {paseo,provider,model,fromId,row}=pending;
  try{
   await controller.ready;
   const state=await controller.store.read();
   if(!state.autoFailover[provider]||!state.integration.enabled||!state.integration.providers.includes(provider)){clearRotation(agentId);return;}
   const current=await controller.accountOf(paseo,agentId,provider,state);
   if(current!==fromId){clearRotation(agentId);return;}
   if(!await controller.usage.checksEnabled()){clearRotation(agentId);return;}
   let usage:Awaited<ReturnType<typeof controller.usage.refresh>>;
   try{usage=await controller.usage.refresh();}
   catch(error){
    console.error(`Could not refresh limits before resuming agent ${agentId}: ${reason(error)}`);
    const retry=new Date(Date.now()+60_000).toISOString();
    scheduleWait(paseo,agentId,provider,model,fromId,row,retry);
    return;
   }
   const currentUsage=usage.find(item=>item.accountId===fromId);
   if(!currentUsage||currentUsage.status!=="ok"){
    const retry=new Date(Date.now()+60_000).toISOString();
    scheduleWait(paseo,agentId,provider,model,fromId,row,retry);
    return;
   }
   const latest=await controller.store.read(),now=Date.now();
   const evidence={currentId:fromId,accounts:latest.accounts.filter(a=>a.provider===provider),usage,model,now,excludedIds:new Set<string>()};
   const decision=failoverDecision(evidence);
   if(!decision){
    // The account that failed can be the first one to reset. Continue on it without a reload; a reload to the same
    // profile would create a needless provider session and can race a user's next message.
    if(!mayBeUsedUp(currentUsage,now)){
     clearRotation(agentId);
     await appendFailoverRow(paseo,agentId,{...row,state:"resumed",to:row.from,toId:fromId,waitsUntil:null});
     if(row.resumes!==false)await paseo.agents.ref(agentId).send(CONTINUE).catch(error=>console.error(`Could not ask agent ${agentId} to continue after its quota reset: ${reason(error)}`));
     return;
    }
    const next=nextResetAt(evidence.accounts,usage,now);
    if(next){
     scheduleWait(paseo,agentId,provider,model,fromId,{...row,state:"waiting",waitsUntil:next},next);
     await appendFailoverRow(paseo,agentId,{...row,state:"waiting",waitsUntil:next});
    }else{
     clearRotation(agentId);
     await appendFailoverRow(paseo,agentId,{...row,state:"none",waitsUntil:null});
    }
    return;
   }
   if(decision.kind!=="offer"){
    const next=nextResetAt(evidence.accounts,usage,now);
    if(next){scheduleWait(paseo,agentId,provider,model,fromId,{...row,state:"waiting",waitsUntil:next},next);await appendFailoverRow(paseo,agentId,{...row,state:"waiting",waitsUntil:next});}
    else {clearRotation(agentId);await appendFailoverRow(paseo,agentId,{...row,state:"none",waitsUntil:null});}
    return;
   }
   const target=latest.accounts.find(account=>account.id===decision.toId);if(!target)return;
   const visited=rotation.get(agentId)??new Set<string>();visited.add(fromId);visited.add(target.id);rotation.set(agentId,visited);
   guard.record(agentId,row.rowId,fromId,target.id,now);
   void switchOver(paseo,agentId,{...row,state:"waiting",to:target.label,toId:target.id,waitsUntil:null},target.id,"auto").catch(error=>{if(error instanceof SwitchRefusal)console.error(`Could not resume agent ${agentId} after a quota reset: ${error.message}`);});
  }catch(error){console.error(`Could not resume agent ${agentId} after a quota reset: ${reason(error)}`);}
 }
 server.handle(rpc.setAutoFailover,async({provider,enabled})=>{await controller.ready;await controller.store.change(r=>{r.autoFailover[provider]=enabled;});if(!enabled)for(const agentId of [...rotation.keys(),...waiting.keys()])clearRotation(agentId);return{};});
 server.handle(rpc.applyFailover,async({agentId,accountId,rowId,fromId},{paseo})=>{
  // Only refusals, written for the user, reach the client as they are; any other error may carry paths or internals.
  // switchOver logs its own failures; one before it is logged here.
  const shown=(error:unknown,logged:boolean)=>{
   if(error instanceof SwitchRefusal)return error;
   if(!logged)console.error(`Could not check the switch offer for agent ${agentId}: ${reason(error)}`);
   return new Error(SWITCH_FAILED);
  };
  let row:FailoverRow,toId:string;
  try{
   // Only this agent's own failover row may be rewritten with the outcome.
   if(!rowId.startsWith(`${FAILOVER_KIND}-${agentId}-`))throw new SwitchRefusal("The switch offer belongs to another agent.");
   // A switch under way keeps its row; checking first also keeps the stale-offer check below from rewriting it.
   if(switching.has(agentId))throw new SwitchRefusal("An account switch is already in progress.");
   await controller.ready;
   const state=await controller.store.read(),target=state.accounts.find(a=>a.id===accountId);
   if(!target)throw new SwitchRefusal("Account not found.");
   // Named at the click: the account the agent leaves now, with a launch not confirmed yet confirmed by its receipt.
   const currentId=await controller.accountOf(paseo,agentId,target.provider,state),from=labelOf(state,currentId);
   if(!currentId||!from)throw new SwitchRefusal("This agent's account is not confirmed yet. Choose an account in the account switcher instead.");
   toId=target.id;
   row={rowId,state:"offered",from,fromId:currentId,to:target.label,toId,resetsAt:null,error:null};
   // An offer made before the agent moved: switching now would leave an account the row never named.
   const stale=currentId===target.id?`The agent already runs on ${target.label}.`:fromId&&fromId!==currentId?`This offer is out of date: the agent now runs on ${from}.`:null;
   if(stale){await appendFailoverRow(paseo,agentId,{...row,state:"failed",error:stale});throw new SwitchRefusal(stale);}
  }catch(error){throw shown(error,false);}
  try{await switchOver(paseo,agentId,row,toId,"switched");}
  catch(error){throw shown(error,true);}
  clearRotation(agentId);
  return{};
 });
 server.handle(rpc.setIntegration,async({enabled},{paseo})=>{const result=await controller.integration(paseo,enabled);if(!enabled)for(const agentId of [...rotation.keys(),...waiting.keys()])clearRotation(agentId);return result;});
 server.handle(rpc.listUsage,async({visible},{paseo})=>{await controller.ensureRuntime(paseo);return{accounts:await controller.usage.list({visible}),checksOff:!await controller.usage.checksEnabled()};});
 server.handle(rpc.refreshUsage,async({accountId},{paseo})=>{await controller.ensureRuntime(paseo);return{accounts:await controller.usage.refresh(accountId),checksOff:!await controller.usage.checksEnabled()};});
 // Paseo's Usage view lists the managed accounts too; a daemon before 0.11 has no usage sources, and the Accounts screen still shows the same limits.
 registerPaseoUsage(server,controller);
 const removeCreate=server.before("agent.create",({request})=>{
  const model=request.config.model;
  if((request.config.provider!=="claude"&&request.config.provider!=="codex")||!model)return request;
  return {...request,env:{...request.env,[MODEL_ENV]:model}};
 });
 const removeHook=server.before("agent.session_open",async({request},{paseo})=>{
  await controller.ready;
  // Neither hint from the creation reaches the CLI, on this or any later session of the agent.
  const {[MODEL_ENV]:model,[ACCOUNT_ENV]:account,...env}=request.env;
  const creating=request.purpose==="interactive"&&request.reason==="create",requested=account?.trim()||null;
  if(creating&&requested&&request.provider!=="claude"&&request.provider!=="codex")throw new SwitchRefusal(`Account Switcher manages only Claude Code and Codex accounts, so the ${request.provider} agent cannot start on ${requested}.`);
  if(creating&&(request.provider==="claude"||request.provider==="codex")){await controller.ensureRuntime(paseo);const bound=await controller.switcher(paseo).bindNewAgent(request.agentId,request.provider,model||null,requested);
   const reason=bound?.reason;
   if(bound&&reason){
    const started=await note(request.agentId,async()=>{const state=await controller.store.read(),to=labelOf(state,bound.accountId);return to?{kind:"started",from:labelOf(state,bound.defaultId),to,reason}:null;});
    const now=Date.now();
    for(const [id,entry] of startNotes)if(now-entry.at>NOTE_TTL)startNotes.delete(id);
    if(started)startNotes.set(request.agentId,{note:started,at:now});
   }
  }
  // Paseo resolves an agent's login, and so its usage, from this session's environment. The launcher applies the profile to the CLI itself; this only lets Paseo see the same one.
  // The registry is read after any binding above, so a new agent already has its profile. A failed read costs only that hint.
  const profile=await controller.store.read().then(state=>profileEnv(state,request.agentId,request.provider),error=>{console.error(`Could not name the account profile for agent ${request.agentId}: ${error instanceof Error?error.message:String(error)}`);return{};});
  // The model hint must not reach the provider CLI.
  return {...request,env:{...env,...profile}};
 });
 const removeCreated=server.on("agent.created",async({agent},{paseo})=>{
  const pending=startNotes.get(agent.id);startNotes.delete(agent.id);
  if(pending)void appendAccountNote(paseo,agent.id,pending.note);
  await controller.observeAgentRegistration(agent.id);
 });
 // Paseo does not say why a turn failed. The evidence is the plugin's own reading of the agent's account, taken again now:
 // a used-up account gets a row, once per exhaustion, and any other failure is left alone.
 // Claude reports a turn its limit stopped as completed (the SDK's error result has subtype "success"), Codex as failed.
 // A completed Claude turn is read again only when the last reading already shows the account used up, and not while
 // its paid extra usage has room: Claude then keeps answering past a full 5-hour window.
 const removeTurnEnded=server.on("agent.turn_ended",async({agent,turnId,outcome},{paseo})=>{
  const provider=agent.provider;
  if(provider!=="claude"&&provider!=="codex")return;
  // A normal turn or an explicit cancellation starts a fresh quota rotation. A failed Codex turn and a completed
  // Claude turn are the two signals that can continue the current automatic run.
  if(outcome.kind==="canceled"||(provider==="codex"&&outcome.kind==="completed")){clearRotation(agent.id);return;}
  const completed=provider==="claude"&&outcome.kind==="completed";
  if(outcome.kind!=="failed"&&!completed)return;
  const rowId=`${FAILOVER_KIND}-${agent.id}-${turnId??Date.now()}`;
  // A switch under way, or the automatic one this turn already had, owns the agent's row: a repeated or concurrent
  // report of the turn adds nothing, so it can neither roll that row back nor start a second switch.
  const settled=(state:Registry)=>switching.has(agent.id)||guard.hasTurn(agent.id,rowId,Date.now())||state.bindings.some(b=>b.agentId===agent.id&&b.status==="switching");
  try{
   await controller.ready;
   const state=await controller.store.read();
   // Without that provider's launcher the CLI runs on the system login, so a switch could not take effect.
   if(!state.integration.enabled||!state.integration.providers.includes(provider)||settled(state)){if(!settled(state))clearRotation(agent.id);return;}
   // With the host's usage checks off nothing can read the account again, and an old reading is no proof that it ran out.
   if(!await controller.usage.checksEnabled()){clearRotation(agent.id);return;}
   // An agent started with no app open may have a launch nothing has confirmed yet; its receipt confirms it now.
   const fromId=await controller.accountOf(paseo,agent.id,provider,state),from=labelOf(state,fromId);
   if(!fromId||!from)return;
   // The cache costs no provider request, so an ordinary completed turn ends here.
   if(completed&&!mayBeUsedUp((await controller.usage.list()).find(item=>item.accountId===fromId),Date.now())){clearRotation(agent.id);return;}
   // A full window read earlier still counts until its reset, so the account is read again before deciding.
   const [usage,snapshot]=await Promise.all([controller.usage.refresh(fromId),paseo.agents.ref(agent.id).refresh().catch(()=>null)]);
   if(completed&&extraUsageLeft(usage.find(item=>item.accountId===fromId))){clearRotation(agent.id);return;}
   // A switch may have started or finished during those reads; from here to the row nothing awaits.
   const latest=await controller.store.read();
   if(settled(latest)||boundAccount(latest,agent.id,provider)!==fromId)return;
   const model=snapshot?.agent.runtimeInfo?.model||snapshot?.agent.model||null,now=Date.now();
   const visited=rotation.get(agent.id)??new Set<string>();visited.add(fromId);rotation.set(agent.id,visited);
   const accounts=latest.accounts.filter(a=>a.provider===provider);
   const decision=failoverDecision({currentId:fromId,accounts,usage,model,now,excludedIds:visited});
   if(!decision){clearRotation(agent.id);return;}
   const offer=decision.kind==="offer"?latest.accounts.find(a=>a.id===decision.toId):undefined;
   const row:FailoverRow={rowId,state:offer?"offered":"none",from,fromId,to:offer?.label??null,toId:offer?.id??null,resetsAt:decision.resetsAt,error:null};
   if(row.toId&&latest.autoFailover[provider]&&guard.allow(agent.id,rowId,fromId,row.toId,now)){
    // Recorded before the first await of the switch: the guard's check and record must not be split.
    guard.record(agent.id,rowId,fromId,row.toId,now);visited.add(row.toId);
    // The switch reloads the agent and waits for its launch, longer than Paseo waits for a hook; the row reports it.
    // A completed turn may have finished its work, so that switch does not ask the agent to continue.
    // switchOver logged any failure but a refusal already.
    void switchOver(paseo,agent.id,completed?{...row,resumes:false}:row,row.toId,"auto").catch(error=>{if(error instanceof SwitchRefusal)console.error(`Could not switch agent ${agent.id} automatically: ${error.message}`);});
    return;
   }
   if(latest.autoFailover[provider]&&!row.toId){
    const next=nextResetAt(accounts,usage,now);
    if(next){
     const key=JSON.stringify([agent.id,fromId,next]);
     if(waiting.has(agent.id)||offered.has(key))return;
     offered.add(key);
     const waitingRow:FailoverRow={...row,...(completed?{resumes:false}:{}),state:"waiting",waitsUntil:next};
     scheduleWait(paseo,agent.id,provider,model,fromId,waitingRow,next);
     await appendFailoverRow(paseo,agent.id,waitingRow);
     return;
    }
   }
   if(!row.toId)clearRotation(agent.id);
   // Recorded before the await, so a turn reported meanwhile finds it.
   const key=JSON.stringify([agent.id,fromId,row.resetsAt]);
   if(offered.has(key))return;
   offered.add(key);
   await appendFailoverRow(paseo,agent.id,row);
  }catch(error){console.error(`Could not check whether agent ${agent.id} ran out of its account's limit: ${reason(error)}`);}
 });
 return async()=>{removeCreate();removeHook();removeCreated();removeTurnEnded();startNotes.clear();for(const timer of waitTimers.values())clearTimeout(timer);waitTimers.clear();waiting.clear();rotation.clear();await controller.close();};
}
