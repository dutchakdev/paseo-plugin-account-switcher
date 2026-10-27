import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as rpc from "./shared/contracts";
import { AccountController } from "./server/controller";
import { accountFrom } from "./server/store";

// Paseo hands `agent.create`'s environment to the same agent's first `agent.session_open`, which alone knows the agent ID.
const MODEL_ENV="PASEO_ACCOUNT_SWITCHER_MODEL";

export default function contribute(server:PluginServerContext){
 const controller=new AccountController();
 server.handle(rpc.listAccounts,async(_,{paseo})=>controller.snapshot(paseo));
 server.handle(rpc.addAccount,async({provider,label},{paseo})=>{await controller.ensureRuntime(paseo);return controller.add(provider,label);});
 server.handle(rpc.renameAccount,async({accountId,label})=>{await controller.ready;return controller.store.change(r=>{const a=accountFrom(r,accountId);a.label=label;return rpc.AccountSchema.parse(a);});});
 server.handle(rpc.removeAccount,async({accountId},{paseo})=>{await controller.remove(accountId,paseo);return{};});
 server.handle(rpc.setDefaultAccount,async({provider,accountId},{paseo})=>{await controller.ensureRuntime(paseo);await controller.setDefault(provider,accountId);return{};});
 server.handle(rpc.startLogin,async({accountId,mode},{paseo})=>{await controller.ensureRuntime(paseo);return controller.startLogin(paseo,accountId,mode);});
 server.handle(rpc.getLoginStatus,async({accountId,sessionId})=>controller.getLoginStatus(accountId,sessionId));
 server.handle(rpc.submitLoginCode,async({accountId,sessionId,code})=>controller.submitLoginCode(accountId,sessionId,code));
 server.handle(rpc.checkLogin,async({accountId},{paseo})=>{await controller.ensureRuntime(paseo);return controller.finishLogin(accountId);});
 server.handle(rpc.cancelLogin,async({accountId,sessionId},{paseo})=>{await controller.ensureRuntime(paseo);return controller.cancelLogin(paseo,accountId,sessionId);});
 server.handle(rpc.prepareSwitch,async({agentId,accountId},{paseo})=>{await controller.ensureRuntime(paseo);return controller.switcher(paseo).prepare(agentId,accountId);});
 server.handle(rpc.applySwitch,async({agentId},{paseo})=>{await controller.ensureRuntime(paseo);const binding=await controller.switcher(paseo).apply(agentId);if(binding.currentAccountId)void controller.usage.refresh(binding.currentAccountId).catch(()=>{});return binding;});
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
  if(request.purpose==="interactive"&&request.reason==="create"&&(request.provider==="claude"||request.provider==="codex")){await controller.ensureRuntime(paseo);await controller.switcher(paseo).bindNewAgent(request.agentId,request.provider,model||null);}
  // The model hint must not reach the provider CLI.
  return {...request,env};
 });
 const removeCreated=server.on("agent.created",async({agent})=>{await controller.observeAgentRegistration(agent.id);});
 return async()=>{removeCreate();removeHook();removeCreated();await controller.close();};
}
