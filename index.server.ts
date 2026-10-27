import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as rpc from "./shared/contracts";
import { AccountController } from "./server/controller";
import { accountFrom } from "./server/store";
import { appendAccountNote } from "./server/timeline";
import type { AccountNote } from "./shared/timeline";

// Paseo hands `agent.create`'s environment to the same agent's first `agent.session_open`, which alone knows the agent ID.
const MODEL_ENV="PASEO_ACCOUNT_SWITCHER_MODEL";

export default function contribute(server:PluginServerContext){
 const controller=new AccountController();
 // Notes are best effort: a failure while preparing one is logged and never changes the switch or the agent's creation.
 const note=async(agentId:string,make:()=>Promise<AccountNote|null>)=>{try{return await make();}catch(error){console.error(`Could not prepare the account note for agent ${agentId}: ${error instanceof Error?error.message:String(error)}`);return null;}};
 const labelOf=(state:Awaited<ReturnType<typeof controller.store.read>>,id:string|null|undefined)=>id?state.accounts.find(a=>a.id===id)?.label??null:null;
 // A new agent's note waits for `agent.created`: its timeline does not exist yet during session_open.
 // An agent whose creation fails never gets that event, so entries expire.
 const startNotes=new Map<string,{note:AccountNote;at:number}>();
 const NOTE_TTL=600_000;
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
  const before=await controller.store.read().catch(()=>null);
  const binding=await controller.switcher(paseo).apply(agentId,accountId);
  if(binding.currentAccountId){
   const to=binding.currentAccountId;
   void controller.usage.refresh(to).catch(()=>{});
   const switched=await note(agentId,async()=>{
    const state=await controller.store.read(),prior=before?.bindings.find(b=>b.agentId===agentId);
    // An agent without a binding ran on its provider's Current CLI account.
    const fromId=prior?prior.currentAccountId:state.accounts.find(a=>a.source==="system"&&a.provider===binding.provider)?.id;
    const label=labelOf(state,to);
    return label?{kind:"switched",from:labelOf(state,fromId),to:label,reason:null}:null;
   });
   if(switched)void appendAccountNote(paseo,agentId,switched);
  }
  return binding;
 });
 server.handle(rpc.setIntegration,({enabled},{paseo})=>controller.integration(paseo,enabled));
 server.handle(rpc.listUsage,async({visible},{paseo})=>{await controller.ensureRuntime(paseo);return{accounts:await controller.usage.list({visible})};});
 server.handle(rpc.refreshUsage,async({accountId},{paseo})=>{await controller.ensureRuntime(paseo);return{accounts:await controller.usage.refresh(accountId)};});
 const removeCreate=server.before("agent.create",({request})=>{
  const model=request.config.model;
  if((request.config.provider!=="claude"&&request.config.provider!=="codex")||!model)return request;
  return {...request,env:{...request.env,[MODEL_ENV]:model}};
 });
 const removeHook=server.before("agent.session_open",async({request},{paseo})=>{
  await controller.ready;
  const {[MODEL_ENV]:model,...env}=request.env;
  if(request.purpose==="interactive"&&request.reason==="create"&&(request.provider==="claude"||request.provider==="codex")){await controller.ensureRuntime(paseo);const bound=await controller.switcher(paseo).bindNewAgent(request.agentId,request.provider,model||null);
   const reason=bound?.reason;
   if(bound&&reason){
    const started=await note(request.agentId,async()=>{const state=await controller.store.read(),to=labelOf(state,bound.accountId);return to?{kind:"started",from:labelOf(state,bound.defaultId),to,reason}:null;});
    const now=Date.now();
    for(const [id,entry] of startNotes)if(now-entry.at>NOTE_TTL)startNotes.delete(id);
    if(started)startNotes.set(request.agentId,{note:started,at:now});
   }
  }
  // The model hint must not reach the provider CLI.
  return {...request,env};
 });
 const removeCreated=server.on("agent.created",async({agent},{paseo})=>{
  const pending=startNotes.get(agent.id);startNotes.delete(agent.id);
  if(pending)void appendAccountNote(paseo,agent.id,pending.note);
  await controller.observeAgentRegistration(agent.id);
 });
 return async()=>{removeCreate();removeHook();removeCreated();startNotes.clear();await controller.close();};
}
