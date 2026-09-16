import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { AccountSchema, type LoginSession, type Provider } from "../shared/contracts";
import { AccountStore, accountFrom, type Registry, type StoredAccount } from "./store";
import { prepareProfile } from "./profiles";
import { accountCommand, accountEnvironment, launchLogin, probeAccount, removeAccountCredentials } from "./auth";
import { installIntegration, restoreIntegration, writeLaunchers, prepareRuntime, reconcileIntegration } from "./integration";
import { SwitchService } from "./switching";
import { createUsageService, readCredentialVersion, type AccountReadOptions, type QuotaAccount } from "./usage";
import { LoginSessions, type LoginDependencies } from "./login";

const execFileAsync=promisify(execFile);
export class AccountController {
 readonly store:AccountStore;
 readonly ready:Promise<void>;
 readonly usage:ReturnType<typeof createUsageService>;
 private readonly checks=new Map<string,Promise<StoredAccount>>();
 private readonly credentialVersions=new Map<string,string>();
 private readonly credentialProofs=new Map<string,{version:string;identityKey:string;generation:number}>();
 private readonly switches=new Map<PaseoApi,SwitchService>();
 private readonly applying=new Set<string>();
 private runtimeReady:Promise<void>|undefined;
 private readonly quotaFlights=new Map<string,Promise<QuotaAccount[]>>();
 private integrationChanging=false;
 private readonly startingLogins=new Set<string>();
 private disposed=false;
 private readonly logins:LoginSessions;
 constructor(root=join(process.env.PASEO_HOME||join(homedir(),".paseo"),"account-switcher"),loginDependencies:Omit<LoginDependencies,"finish">={}) {
  this.store=new AccountStore(root);
  this.logins=new LoginSessions({...loginDependencies,finish:(id,token,successful)=>this.completeBackgroundLogin(id,token,successful)});
  this.ready=this.store.initialize({claude:resolve(process.env.CLAUDE_CONFIG_DIR||join(homedir(),".claude")),codex:resolve(process.env.CODEX_HOME||join(homedir(),".codex"))}).then(async()=>{
   await writeLaunchers(this.store);
   // A crash during reload must not leave an unconfirmed account marked applied.
   await this.store.change(state=>{for(const b of state.bindings){if(b.status==="switching"){b.currentAccountId=null;b.launchToken=null;b.status="error";b.error="The account switch was interrupted. Account not confirmed; apply the account again.";}}});
  });
  this.usage=createUsageService({getAccounts:input=>this.quotaAccounts(input),cachePath:join(root,"usage-cache.json")});
  void this.ready.then(()=>{if(!this.disposed)this.usage.start();}).catch(()=>{});
 }
 async ensureRuntime(paseo:PaseoApi){
  await this.ready;
  if(!this.runtimeReady){this.runtimeReady=prepareRuntime(paseo,this.store).catch(error=>{this.runtimeReady=undefined;throw error;});}
  await this.runtimeReady;
  await reconcileIntegration(paseo,this.store);
 }
 async snapshot(paseo:PaseoApi){
  await this.ensureRuntime(paseo);
  await this.reconcileDeletedAgents(paseo);
  await this.reconcileLogins();
  const state=await this.store.read();
  for(const binding of state.bindings.filter(b=>state.integration.enabled&&!this.integrationChanging&&b.currentAccountId===null&&b.status==="ready"&&b.launchAccountId&&b.launchToken)){
   try{
    const receipt=JSON.parse(await readFile(join(this.store.root,"receipts",encodeURIComponent(binding.agentId)+".json"),"utf8"));
    if(receipt.accountId!==binding.launchAccountId||receipt.launchToken!==binding.launchToken)continue;
    const live=await paseo.agents.ref(binding.agentId).refresh();
    if(!live||!["idle","running"].includes(live.agent.status))continue;
    await this.store.change(r=>{const b=r.bindings.find(b=>b.agentId===binding.agentId);if(r.integration.enabled&&!this.integrationChanging&&b&&b.launchToken===binding.launchToken&&b.launchAccountId===binding.launchAccountId&&b.currentAccountId===null&&b.status==="ready"){b.currentAccountId=binding.launchAccountId;b.launchToken=null;b.registrationObserved=true;}});
   }catch{/* The UI keeps the account unconfirmed until native startup succeeds. */}
  }
  return this.store.snapshot();
 }
 async observeAgentRegistration(agentId:string){
  await this.ready;
  await this.store.change(r=>{const binding=r.bindings.find(b=>b.agentId===agentId);if(binding)binding.registrationObserved=true;});
 }
 private async reconcileDeletedAgents(paseo:PaseoApi){
  const before=await this.store.read();
  if(!before.bindings.length)return;
  const captured=new Map(before.bindings.map(binding=>[binding.agentId,JSON.stringify(binding)]));
  const existing=new Set<string>(),cursors=new Set<string>();
  let cursor:string|undefined,complete=false;
  try{
   for(let page=0;page<1000;page++){
    const result=await paseo.agents.list({filter:{includeArchived:true},page:{limit:200,...(cursor?{cursor}:{})}});
    if(!Array.isArray(result.entries)||typeof result.pageInfo?.hasMore!=="boolean")return;
    for(const entry of result.entries){const id=entry.agent?.id;if(typeof id!=="string"||!id||existing.has(id))return;existing.add(id);}
    if(!result.pageInfo.hasMore){if(result.pageInfo.nextCursor!==null)return;complete=true;break;}
    const next=result.pageInfo.nextCursor;if(typeof next!=="string"||!next||cursors.has(next))return;cursors.add(next);cursor=next;
   }
  }catch{return;}
  if(!complete)return;
  await this.store.change(r=>{
   r.bindings=r.bindings.filter(binding=>{
    if(existing.has(binding.agentId)){binding.registrationObserved=true;return true;}
    if(captured.get(binding.agentId)!==JSON.stringify(binding)||this.applying.has(binding.agentId)||binding.status==="switching")return true;
    // session_open runs before native creation/registration. A default binding
    // that has never appeared in Paseo is not proof of a deleted agent.
    return !binding.registrationObserved&&binding.currentAccountId===null;
   });
  });
 }
 async setDefault(provider:Provider,id:string|null){
  await this.ready;
  if(id===null){await this.store.change(r=>{r.defaults[provider]=null;});return;}
  const before=await this.store.read(),account=accountFrom(before,id);
  if(account.provider!==provider)throw new Error("The account belongs to another provider.");
  if(account.loginToken)throw new Error("Account sign-in is still in progress.");
  const checked=await this.checkAccount(id);
  if(checked.authStatus!=="ready")throw new Error("Sign in and verify authentication before making this the default account.");
  await this.store.change(r=>{const current=accountFrom(r,id);if(r.defaults[provider]!==before.defaults[provider])throw new Error("The default account changed; select it again.");if(current.loginToken||current.generation!==checked.generation||current.authStatus!=="ready")throw new Error("Account authentication changed; check sign-in again.");r.defaults[provider]=id;});
 }
 async checkAccount(id:string,verifyCredentials=false):Promise<StoredAccount> {
  await this.ready;
  const existing=this.checks.get(id);
  if(existing){if(!verifyCredentials)return existing;await existing.catch(()=>{});return this.checkAccount(id,true);}
  const task=(async()=>{
   const state=await this.store.read(), account=accountFrom(state,id);
   if(account.loginToken)throw new Error("Finish signing in, then click “Check sign-in”.");
   let identity:Awaited<ReturnType<typeof probeAccount>>;
   let stableVersion:string|undefined;
   if(verifyCredentials){
    this.credentialProofs.delete(id);
    const quota=this.toQuotaAccount(account,state);
    for(let attempt=0;;attempt++){
     const before=await readCredentialVersion(quota);
     identity=await probeAccount(account,state);
     const after=await readCredentialVersion(quota);
     if(after!=="unavailable")this.credentialVersions.set(id,after);
     if(before===after&&after.startsWith("present:")){stableVersion=after;break;}
     if(attempt===1||before==="unavailable"||after==="unavailable")break;
    }
   }else identity=await probeAccount(account,state);
   // A transient CLI failure cannot change identity or discard the last quota.
   const updated=await this.store.updateIdentity(id,identity.authStatus==="error"?{identityKey:account.identityKey,email:account.email,plan:account.plan,authStatus:"error"}:identity,account);
   if(stableVersion&&identity.authStatus==="ready"&&identity.identityKey&&updated.authStatus==="ready"&&updated.identityKey===identity.identityKey&&!updated.loginToken)this.credentialProofs.set(id,{version:stableVersion,identityKey:identity.identityKey,generation:updated.generation});
   if(updated.generation!==account.generation&&!verifyCredentials)await this.usage.invalidate(id);
   return updated;
  })();
  this.checks.set(id,task);
  try{return await task;}finally{if(this.checks.get(id)===task)this.checks.delete(id);}
 }
 async quotaAccounts(input:AccountReadOptions={}):Promise<QuotaAccount[]> {
  const key=input.verifyAccountId??"";
  const existing=this.quotaFlights.get(key);if(existing)return existing;
  const task=this.readQuotaAccounts(input);this.quotaFlights.set(key,task);
  try{return await task;}finally{if(this.quotaFlights.get(key)===task)this.quotaFlights.delete(key);}
 }
 private async readQuotaAccounts(input:AccountReadOptions):Promise<QuotaAccount[]> {
  await this.ready;
  await this.reconcileLogins();
  const initial=await this.store.read();
  const target=initial.accounts.find(account=>account.id===input.verifyAccountId);
  if(target&&initial.commands[target.provider]&&!target.loginToken)await this.checkAccount(target.id,true).catch(()=>{this.credentialProofs.delete(target.id);});
  const state=await this.store.read();
  return state.accounts.filter(a=>state.commands[a.provider]&&!a.loginToken).map(account=>this.toQuotaAccount(account,state));
 }
 private toQuotaAccount(account:StoredAccount,state:Registry):QuotaAccount {
   const env=accountEnvironment(account,state);
   const credentialHome=account.provider==="claude"?(env.CLAUDE_SECURESTORAGE_CONFIG_DIR??env.CLAUDE_CONFIG_DIR)||join(env.HOME||homedir(),".claude"):account.home;
   const quota:QuotaAccount={id:account.id,provider:account.provider,home:credentialHome,identityKey:account.identityKey,generation:account.generation,command:accountCommand(state,account.provider),env,requireIdentityVerification:account.identityKey!==null};
   quota.credentialVersion=this.credentialVersions.get(account.id);
   const proof=this.credentialProofs.get(account.id);
   if(account.authStatus==="ready"&&proof?.identityKey===account.identityKey&&proof?.generation===account.generation)quota.identityCredentialVersion=proof.version;
   return quota;
 }
 async add(provider:Provider,label:string) {
  await this.ready;
  const account=await this.store.add(provider,label);
  try{const state=await this.store.read();await prepareProfile({provider,home:account.home,sourceHome:state.sourceHomes[provider],sourceEnvironment:state.sourceEnvironment[provider]});return AccountSchema.parse(account);}
  catch(error){await this.store.remove(account.id,async()=>{await rm(dirname(account.home),{recursive:true,force:true});});throw error;}
 }
 async login(paseo:PaseoApi,id:string,workspaceId?:string,mode?:"device"|"browser") {
  await this.ready;
  await this.reconcileDeletedAgents(paseo);
  if(this.startingLogins.has(id))throw new Error("Sign-in is already being prepared.");
  const token=randomUUID();
  await this.store.change(state=>{const account=accountFrom(state,id);if(account.source!=="managed")throw new Error("Add a separate account for isolated sign-in.");if(account.loginToken)throw new Error("Sign-in is already open. Continue in the Paseo terminal.");if(state.bindings.some(b=>b.currentAccountId===id||b.launchAccountId===id||b.currentAccountId===null&&b.pendingAccountId===id))throw new Error("Switch agents away from this account before signing in again.");account.loginToken=token;account.login=null;});
  this.usage.invalidate(id);
  this.startingLogins.add(id);
  try{
   // A status probe started before the reservation must finish before the CLI
   // can replace credentials. Completion then always probes the new identity.
   await this.checks.get(id)?.catch(()=>{});
   const session=await launchLogin(paseo,this.store,id,workspaceId,mode);
   await this.store.change(r=>{const a=accountFrom(r,id);if(a.loginToken===token)a.login=session;});
   return session;
  }catch(error){await this.store.change(r=>{const a=accountFrom(r,id);if(a.loginToken===token){a.loginToken=null;a.login=null;}});throw error;}
  finally{this.startingLogins.delete(id);}
 }
 async startLogin(paseo:PaseoApi,id:string,mode:"device"|"browser"="device"):Promise<LoginSession>{
  await this.ready;
  if(this.disposed)throw new Error("Account sign-in is shutting down. Try again shortly.");
  await this.reconcileDeletedAgents(paseo);
  if(this.startingLogins.has(id))throw new Error("Sign-in is already being prepared.");
  this.startingLogins.add(id);
  const token=randomUUID();
  try{
   const registry=await this.store.read(),account=accountFrom(registry,id);
   if(account.loginToken)throw new Error("Sign-in is already open. Continue or cancel the current attempt.");
   if(account.source!=="managed")throw new Error("Add a separate account for isolated sign-in.");
   return await this.logins.start(account,registry,this.store.root,token,mode,async()=>{
    await this.store.change(state=>{const current=accountFrom(state,id);if(current.loginToken)throw new Error("Sign-in is already open. Continue or cancel the current attempt.");if(state.bindings.some(b=>b.currentAccountId===id||b.launchAccountId===id||b.currentAccountId===null&&b.pendingAccountId===id))throw new Error("Switch agents away from this account before signing in again.");current.loginToken=token;current.login={sessionId:token,mode:account.provider==="claude"?"browser":mode};});
    this.usage.invalidate(id);
    await this.checks.get(id)?.catch(()=>{});
   });
  }catch(error){
   // LoginSessions stops its already-established watchdog before rejecting.
   // Clear only our reservation, never a newer attempt.
   if(!this.logins.has(id,token))await this.store.change(r=>{const account=accountFrom(r,id);if(account.loginToken===token){account.loginToken=null;account.login=null;}});
   throw error;
  }finally{this.startingLogins.delete(id);}
 }
 private async completeBackgroundLogin(id:string,token:string,successful:boolean):Promise<boolean>{
  const cleared=await this.store.change(state=>{const account=accountFrom(state,id);if(account.loginToken!==token)return false;account.loginToken=null;account.login=null;return true;});
  if(!cleared)return false;
  const account=await this.checkAccount(id);
  void this.usage.refresh(id).catch(()=>{});
  return successful&&account.authStatus==="ready"&&!account.loginToken;
 }
 async getLoginStatus(id:string,sessionId:string):Promise<LoginSession>{
  await this.ready;
  if(this.logins.has(id,sessionId))return this.logins.status(id,sessionId);
  const account=accountFrom(await this.store.read(),id);
  if(!account.login||!("sessionId" in account.login)||account.login.sessionId!==sessionId)throw new Error("This sign-in attempt is no longer active. Start sign-in again.");
  let completed=false;
  try{const receipt=JSON.parse(await readFile(join(this.store.root,"logins",id+".json"),"utf8"));if(receipt.loginToken===sessionId){const checked=await this.finishLogin(id);completed=receipt.exitCode===0&&checked.authStatus==="ready";}}catch{/* The watchdog must confirm exit before releasing the reservation. */}
  return{id:sessionId,accountId:id,provider:account.provider,mode:account.login.mode,status:completed?"complete":"error",authorizationUrl:null,userCode:null,canSubmitCode:false,expiresAt:null,error:completed?null:"Sign-in was interrupted. Cancel this attempt, then start sign-in again."};
 }
 async submitLoginCode(id:string,sessionId:string,code:string):Promise<LoginSession>{
  await this.ready;
  if(accountFrom(await this.store.read(),id).loginToken!==sessionId)throw new Error("This sign-in attempt is no longer active. Start sign-in again.");
  return this.logins.submit(id,sessionId,code);
 }
 async cancelLogin(paseo:PaseoApi,id:string,sessionId?:string){
  await this.ready;
  if(this.startingLogins.has(id))throw new Error("The sign-in terminal is still being prepared. Try again shortly.");
  const account=accountFrom(await this.store.read(),id),token=account.loginToken;
  if(sessionId&&token!==sessionId)throw new Error("This sign-in attempt is no longer active. Start sign-in again.");
  if(!token)return AccountSchema.parse(await this.checkAccount(id));
  if(account.login&&"sessionId" in account.login){
   if(!sessionId)throw new Error("Select the current sign-in attempt before canceling it.");
   if(this.logins.has(id,token))await this.logins.cancel(id,token);
   else{
    let receipt;try{receipt=JSON.parse(await readFile(join(this.store.root,"logins",id+".json"),"utf8"));}catch{throw new Error("The previous sign-in is still stopping. Try canceling again shortly.");}
    if(receipt.loginToken!==token)throw new Error("The previous sign-in is still stopping. Try canceling again shortly.");
   }
   await this.store.change(r=>{const current=accountFrom(r,id);if(current.loginToken===token){current.loginToken=null;current.login=null;}});
   this.usage.invalidate(id);return AccountSchema.parse(await this.checkAccount(id));
  }
  const terminals=account.login&&"terminalId" in account.login?[account.login.terminalId]:(await paseo.terminals.list({cwd:join(this.store.root,"login",id)})).entries.map(t=>t.id);
  for(const terminalId of terminals){const terminal=paseo.terminals.ref(terminalId);if(await terminal.refresh())await terminal.kill();}
  await this.store.change(r=>{const a=accountFrom(r,id);if(a.loginToken===token){a.loginToken=null;a.login=null;}});
  this.usage.invalidate(id);
  return AccountSchema.parse(await this.checkAccount(id));
 }
 private async reconcileLogins(){
  const state=await this.store.read();
  for(const account of state.accounts.filter(a=>a.loginToken)){
   if(account.login&&"sessionId" in account.login&&this.logins.has(account.id,account.login.sessionId))continue;
   try{
    const receipt=JSON.parse(await readFile(join(this.store.root,"logins",account.id+".json"),"utf8"));
    if(receipt.loginToken===account.loginToken)await this.finishLogin(account.id);
   }catch{/* Pending login remains reserved; the UI can still check explicitly. */}
  }
 }
 async finishLogin(id:string) {
  const before=accountFrom(await this.store.read(),id);
  if(before.login&&"sessionId" in before.login&&this.logins.has(id,before.login.sessionId))throw new Error("Sign-in is still in progress. Continue in the sign-in dialog.");
  if(before.loginToken){
   let receipt;try{receipt=JSON.parse(await readFile(join(this.store.root,"logins",id+".json"),"utf8"));}catch{throw new Error("Sign-in in the terminal has not finished yet.");}
   if(receipt.loginToken!==before.loginToken)throw new Error("Sign-in in the terminal has not finished yet.");
   await this.store.change(r=>{const a=accountFrom(r,id);if(a.loginToken===before.loginToken){a.loginToken=null;a.login=null;}});
  }
  const account=await this.checkAccount(id);
  void this.usage.refresh(id).catch(()=>{});
  return AccountSchema.parse(account);
 }
 async remove(id:string,paseo?:PaseoApi) {
  await this.ready;
  if(paseo)await this.reconcileDeletedAgents(paseo);
  const account=accountFrom(await this.store.read(),id);
  await this.store.remove(id,async(account,state)=>{
   if(account.loginToken)throw new Error("Finish signing in in the terminal first.");
   if(!/^[A-Za-z0-9_-]+$/.test(id)||resolve(account.home)!==join(this.store.root,"accounts",id,account.provider))throw new Error("Invalid profile path.");
   const root=await realpath(this.store.root),paths:string[]=[];
   for(const [directory,name] of [["accounts",id],["login",id],["logins",`${id}.json`]]){
    const parent=join(this.store.root,directory);
    try{if(!(await lstat(parent)).isDirectory()||await realpath(parent)!==join(root,directory))throw new Error("The plugin directory has been redirected; cleanup was refused.");paths.push(join(parent,name));}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
   }
   await removeAccountCredentials(account,state);
   for(const path of paths)await rm(path,{recursive:true,force:true});
  });
  await this.usage.invalidate(id);
  this.credentialVersions.delete(account.id);this.credentialProofs.delete(account.id);
 }
 async integration(paseo:PaseoApi,enabled:boolean) {
  await this.ready;
  if(this.applying.size||this.integrationChanging)throw new Error("Wait for the integration or account change to finish.");
  this.integrationChanging=true;
  try{
   if(enabled)await installIntegration(paseo,this.store);else {await restoreIntegration(paseo,this.store);await this.store.change(r=>{for(const b of r.bindings){b.launchToken=null;if(b.currentAccountId!==`system-${b.provider}`){b.pendingAccountId=b.pendingAccountId??b.currentAccountId??b.launchAccountId;b.currentAccountId=null;b.status="error";b.error="Integration is disabled. The next reload will use the system CLI.";}}});}
   return this.store.snapshot();
  }finally{this.integrationChanging=false;}
 }
 switcher(paseo:PaseoApi):SwitchService {
  let service=this.switches.get(paseo);if(service)return service;
  const requireIntegration=async()=>{if(this.integrationChanging)throw new Error("An integration change is still in progress.");await reconcileIntegration(paseo,this.store);if(!(await this.store.read()).integration.enabled)throw new Error("Account integration is no longer active. Check its settings and enable it again.");};
  service=new SwitchService({store:this.store,applying:this.applying,checkAccount:async id=>{await requireIntegration();return this.checkAccount(id);},inspect:async(id)=>{
   const result=await paseo.agents.ref(id).refresh();if(!result)throw new Error("Agent not found.");
   const a=result.agent;
   return{provider:a.provider,busy:a.status==="running"||a.status==="initializing"||!!a.activeTurn||a.pendingPermissions.length>0,archived:!!a.archivedAt};
  },reload:async(id)=>{
   await requireIntegration();
   const config=JSON.parse(await readFile(join(dirname(this.store.root),"config.json"),"utf8"));
   const listen=config.daemon?.listen;
   if(typeof listen!=="string"||!listen)throw new Error("Could not identify the daemon for reload.");
   const host=listen.replace(/^0\.0\.0\.0:/,"127.0.0.1:");
   try{await execFileAsync("paseo",["agent","reload",id,"--json","--host",host],{timeout:120_000,maxBuffer:1024*1024,env:process.env});}
   catch{throw new Error("The native agent reload failed. Check the agent status and try again.");}
  }});
  this.switches.set(paseo,service);return service;
 }
 async close(){this.disposed=true;await this.logins.close();await this.usage.close();}
}
