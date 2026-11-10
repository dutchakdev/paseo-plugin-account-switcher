import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as rpc from "./shared/contracts";
import { AccountController } from "./server/controller";
import { ContinuationObservation, recoveryAgent } from "./server/continuation-observation";
import { ContinuationCoordinator } from "./server/continuation";
import { readClaudeTurnMessageId } from "./server/continuation-timeline";
import { ContinuationLedger } from "./server/continuation-ledger";
import { readClaudeQuota } from "./server/claude-quota";
import type { PaseoApi } from "./server/paseo-api";
import { registerPaseoUsage } from "./server/paseo-usage";
import { profileEnv } from "./server/session-env";
import { accountFrom } from "./server/store";
import { SwitchRefusal } from "./server/switching";
import { appendAccountNote, appendFailoverRow } from "./server/timeline";
import type { AccountNote } from "./shared/timeline";

// Paseo hands `agent.create`'s environment to the same agent's first `agent.session_open`, which alone knows the agent ID.
const MODEL_ENV="PASEO_ACCOUNT_SWITCHER_MODEL";
// Set by whoever creates the agent (e.g. `paseo run --env PASEO_ACCOUNT_SWITCHER_ACCOUNT=Work`): the account it starts on.
const ACCOUNT_ENV="PASEO_ACCOUNT_SWITCHER_ACCOUNT";
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
 const handle:PluginServerContext["handle"]=(contract,handler)=>server.handle(contract,(input,context)=>{observe(context.paseo);return handler(input,context);});
 handle(rpc.listAccounts,async(_,{paseo})=>controller.snapshot(paseo));
 handle(rpc.addAccount,async({provider,label},{paseo})=>{await controller.ensureRuntime(paseo);return controller.add(provider,label);});
 handle(rpc.renameAccount,async({accountId,label})=>{await controller.ready;return controller.store.change(r=>{const a=accountFrom(r,accountId);a.label=label;return rpc.AccountSchema.parse(a);});});
 handle(rpc.removeAccount,async({accountId},{paseo})=>{await controller.remove(accountId,paseo);return{};});
 handle(rpc.setFallback,async({provider,enabled})=>{await controller.ready;await controller.store.change(r=>{r.fallback[provider]=enabled;});return{};});
 handle(rpc.setDefaultAccount,async({provider,accountId},{paseo})=>{await controller.ensureRuntime(paseo);await controller.setDefault(provider,accountId);return{};});
 handle(rpc.startLogin,async({accountId,mode},{paseo})=>{await controller.ensureRuntime(paseo);return controller.startLogin(paseo,accountId,mode);});
 handle(rpc.getLoginStatus,async({accountId,sessionId})=>controller.getLoginStatus(accountId,sessionId));
 handle(rpc.submitLoginCode,async({accountId,sessionId,code})=>controller.submitLoginCode(accountId,sessionId,code));
 handle(rpc.checkLogin,async({accountId},{paseo})=>{await controller.ensureRuntime(paseo);return controller.finishLogin(accountId);});
 handle(rpc.cancelLogin,async({accountId,sessionId},{paseo})=>{await controller.ensureRuntime(paseo);return controller.cancelLogin(paseo,accountId,sessionId);});
 handle(rpc.prepareSwitch,async({agentId,accountId},{paseo})=>{continuation.invalidate(agentId);await controller.ensureRuntime(paseo);const result=await controller.switcher(paseo).prepare(agentId,accountId);observation.refreshAgent(agentId);return result;});
 handle(rpc.applySwitch,async({agentId,accountId},{paseo})=>{
  continuation.invalidate(agentId);
  await controller.ensureRuntime(paseo);
  // The registry as the agent left it: the note names the account from its binding.
  const before=await controller.store.read().catch(()=>null);
  const binding=await controller.switcher(paseo).apply(agentId,accountId);
  if(binding.currentAccountId){
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
  observation.refreshAgent(agentId);
  return binding;
 });
 const continuation=new ContinuationCoordinator(new ContinuationLedger(controller.store.root),{
  read:async(paseo,id)=>{
   await controller.ready;
   const result=await paseo.agents.ref(id).refresh();if(!result)return null;
   const provider=result.agent.provider;if(provider!=="claude"&&provider!=="codex")return null;
   const accountId=await controller.accountOf(paseo,id,provider);
   const registry=await controller.store.read();
   return{agent:recoveryAgent(result.agent),accountId,registry};
  },
  refresh:async paseo=>{await controller.ensureRuntime(paseo);return await controller.usage.checksEnabled()?controller.usage.refresh():null;},
  claudeMessageId:readClaudeTurnMessageId,
  claude:readClaudeQuota,
  switch:async(paseo,id,target,operation)=>{await controller.ensureRuntime(paseo);return controller.switcher(paseo).switchTo(id,target,operation);},
  send:async(paseo,id,messageId)=>{await paseo.agents.ref(id).send("Continue.",{messageId,activeTurnBehavior:"steer"});},
  row:appendFailoverRow,
  now:Date.now,
  permitsRecovery:(paseo,id)=>observation.permitsRecovery(paseo,id),
  log:(agentId,code)=>console.info(JSON.stringify({kind:"quota_recovery",agentId,code})),
 });
 const observation=new ContinuationObservation(continuation);
 const observe=(paseo:PaseoApi)=>{void observation.ensure(paseo);};
 handle(rpc.setAutoFailover,async({provider,enabled})=>{await controller.ready;await controller.store.change(r=>{r.autoFailover[provider]=enabled;});return{};});
 handle(rpc.applyFailover,async(input,{paseo})=>{
  try{await continuation.apply(paseo,input);return{};}
  catch(error){if(error instanceof SwitchRefusal)throw error;console.error("Account recovery stopped; inspect Accounts.");throw new Error(SWITCH_FAILED);}
 });
 handle(rpc.setIntegration,({enabled},{paseo})=>controller.integration(paseo,enabled));
 handle(rpc.listUsage,async({visible},{paseo})=>{await controller.ensureRuntime(paseo);return{accounts:await controller.usage.list({visible}),checksOff:!await controller.usage.checksEnabled()};});
 handle(rpc.refreshUsage,async({accountId},{paseo})=>{await controller.ensureRuntime(paseo);return{accounts:await controller.usage.refresh(accountId),checksOff:!await controller.usage.checksEnabled()};});
 // Paseo's Usage view lists the managed accounts too; a daemon before 0.11 has no usage sources, and the Accounts screen still shows the same limits.
 registerPaseoUsage(server,controller);
 const removeCreate=server.before("agent.create",({request})=>{
  const model=request.config.model;
  if((request.config.provider!=="claude"&&request.config.provider!=="codex")||!model)return request;
  return {...request,env:{...request.env,[MODEL_ENV]:model}};
 });
 const removeHook=server.before("agent.session_open",async({request},{paseo})=>{
  observe(paseo);
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
 const removeTurnStarted=server.on("agent.turn_started",(event,{paseo})=>{
  observe(paseo);continuation.started(event,paseo);observation.refreshAgent(event.agent.id,false);
 });
 const removeTurnEnded=server.on("agent.turn_ended",(event,{paseo})=>{
  observe(paseo);
  if(event.agent.provider==="claude"&&event.outcome.kind==="canceled")observation.canceled(event.agent.id);
  // Detached: native reload and launch receipts can outlive the hook deadline. The coordinator owns cancellation.
  void continuation.ended(event,paseo).catch(()=>console.error("Account recovery stopped; inspect Accounts."));
 });
 const removePermission=server.on("agent.permission_requested",({agent})=>{continuation.invalidate(agent.id);observation.refreshAgent(agent.id,false);});
 const removeArchived=server.on("agent.archived",({agent})=>{continuation.invalidate(agent.id);observation.refreshAgent(agent.id,false);});
 const removeClosed=server.on("agent.closed",({agent})=>continuation.closed(agent.id));
 return async()=>{removeCreate();removeHook();removeCreated();removeTurnStarted();removeTurnEnded();removePermission();removeArchived();removeClosed();startNotes.clear();const stoppingObservation=observation.stop();await continuation.stop();await stoppingObservation;await controller.close();};
}
