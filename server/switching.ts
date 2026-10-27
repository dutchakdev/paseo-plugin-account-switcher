import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BindingSchema, cliName, type Binding, type Provider, type UsageSnapshot } from "../shared/contracts";
import { defaultBlocker, launchOrder, type Blocker } from "./selection";
import { AccountStore, accountFrom, type StoredBinding } from "./store";

export interface SwitchDependencies {
 store:AccountStore;
 inspect:(agentId:string)=>Promise<{provider:string;busy:boolean;archived:boolean}>;
 checkAccount:(accountId:string)=>Promise<{authStatus:string}>;
 reload:(agentId:string)=>Promise<void>;
 /** Last known limits; read from the cache, so creating an agent never waits for a provider. */
 usage?:()=>Promise<UsageSnapshot[]>;
 applying?:Set<string>;
 receiptTimeoutMs?:number;
}
/** A switch refused for a reason written for the user: the chat may show its message. Any other error may carry
 * paths or internals, and only the plugin log gets it. */
export class SwitchRefusal extends Error { override readonly name = "SwitchRefusal"; }
// Paseo 0.11 starts provider CLIs lazily, so the launch receipt can land after reload returns.
async function confirmLaunch(root:string,agentId:string,accountId:string,token:string,timeoutMs:number):Promise<boolean>{
 const path=join(root,"receipts",encodeURIComponent(agentId)+".json"),deadline=Date.now()+timeoutMs;
 for(;;){
   try{const receipt=JSON.parse(await readFile(path,"utf8"));if(receipt.accountId===accountId&&receipt.launchToken===token)return true;}
   catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT"&&!(error instanceof SyntaxError))throw error;}
   if(Date.now()>=deadline)return false;
   await new Promise(done=>setTimeout(done,100));
 }
}
export class SwitchService {
 private applying:Set<string>;
 private receiptTimeoutMs:number;
 constructor(private readonly deps:SwitchDependencies){this.applying=deps.applying??new Set();this.receiptTimeoutMs=deps.receiptTimeoutMs??15_000;}
 async prepare(agentId:string,accountId:string|null):Promise<Binding>{
   if(this.applying.has(agentId))throw new SwitchRefusal("An account switch is already in progress.");
   const agent=await this.deps.inspect(agentId);
   if(agent.archived)throw new SwitchRefusal("The agent is archived.");
   if(agent.provider!=="claude"&&agent.provider!=="codex")throw new SwitchRefusal("Only Claude and Codex are supported.");
   return BindingSchema.parse(await this.deps.store.prepare(agentId,agent.provider,accountId));
 }
 /** `expected` is the account the caller showed or named; another client's later selection must not be applied in its place.
  * `switching` is told once the binding has started switching; a failure from then on is rolled back here. */
 async apply(agentId:string,expected?:string,switching?:()=>void):Promise<Binding>{
   if(this.applying.has(agentId))throw new SwitchRefusal("An account switch is already in progress.");
   this.applying.add(agentId);
   let previous:StoredBinding|undefined;
   const token=randomUUID();
   try {
     const {store}=this.deps, state=await store.read();
     if(!state.integration.enabled)throw new SwitchRefusal("Enable account integration first.");
     const selected=state.bindings.find(b=>b.agentId===agentId);
     if(!selected?.pendingAccountId)throw new SwitchRefusal("Select an account first.");
     if(expected&&selected.pendingAccountId!==expected)throw new SwitchRefusal("The account selection changed; try again.");
     const target=accountFrom(state,selected.pendingAccountId);
     // Without the launcher in its command, the provider would never confirm the new account.
     if(!state.integration.providers.includes(target.provider))throw new SwitchRefusal(`Account switching is off for ${cliName[target.provider]}. Enable integration again to include it.`);
     if(target.loginToken)throw new SwitchRefusal("Finish signing in to the selected account first.");
     const assertIdle=async()=>{const agent=await this.deps.inspect(agentId);if(agent.archived)throw new SwitchRefusal("The agent is archived.");if(agent.provider!==target.provider)throw new SwitchRefusal("The agent provider changed.");if(agent.busy)throw new SwitchRefusal("Wait for the agent to finish its response.");};
     await assertIdle();
     if((await this.deps.checkAccount(target.id)).authStatus!=="ready")throw new SwitchRefusal("Sign in to the selected account first.");
     await assertIdle();
     previous=await store.change(r=>{const b=r.bindings.find(b=>b.agentId===agentId);if(!r.integration.enabled||!b||b.pendingAccountId!==target.id||b.status==="switching")throw new SwitchRefusal("The account selection changed; try again.");if(accountFrom(r,target.id).loginToken)throw new SwitchRefusal("Account sign-in is still in progress.");const old=structuredClone(b);b.status="switching";b.error=null;b.launchAccountId=target.id;b.launchToken=token;return old;});
     switching?.();
     await this.deps.reload(agentId);
     if(!await confirmLaunch(store.root,agentId,target.id,token,this.receiptTimeoutMs))throw new SwitchRefusal("The new account did not confirm its launch.");
     return await store.change(r=>{const b=r.bindings.find(b=>b.agentId===agentId);if(!r.integration.enabled||!b||b.launchToken!==token)throw new SwitchRefusal("The account switch state changed.");b.currentAccountId=target.id;b.pendingAccountId=null;b.status="ready";b.error=null;b.launchToken=null;b.registrationObserved=true;return BindingSchema.parse(b);});
   } catch(error) {
     if(previous){
       const rollback=previous,rollbackToken=randomUUID();
       const claimed=await this.deps.store.change(r=>{const b=r.bindings.find(b=>b.agentId===agentId);if(b?.launchToken!==token)return false;b.currentAccountId=null;b.launchAccountId=rollback.currentAccountId??b.launchAccountId;b.launchToken=rollbackToken;b.status="switching";return true;});
       if(!claimed)throw error;
       let restored=false;
       if(rollback.currentAccountId){
         try{
           const agent=await this.deps.inspect(agentId);if(agent.busy||agent.archived)throw new Error("Agent is busy");
           await this.deps.reload(agentId);
           restored=await confirmLaunch(this.deps.store.root,agentId,rollback.currentAccountId,rollbackToken,this.receiptTimeoutMs);
         }catch{/* Keep the account unknown unless rollback launch is confirmed. */}
       }
       await this.deps.store.change(r=>{const b=r.bindings.find(b=>b.agentId===agentId);if(b?.launchToken===rollbackToken){b.currentAccountId=restored?rollback.currentAccountId:null;b.pendingAccountId=rollback.pendingAccountId;b.status="error";b.launchToken=null;b.error=restored?"The account switch failed. The previous account was restored.":"Account not confirmed for the running session. Select an account and apply it again.";}});
     }
     throw error;
   } finally {this.applying.delete(agentId);}
 }
 /** Selects `accountId` and applies it in one step, for a switch the user did not select in the switcher (the failover
  * row's button, the automatic switch). A refusal before the binding starts switching puts the agent's selection back
  * as it was and drops a binding this call created, so no selection the user never made is left pending. */
 async switchTo(agentId:string,accountId:string):Promise<Binding>{
   const {store}=this.deps,before=(await store.read()).bindings.find(b=>b.agentId===agentId);
   const prepared=await this.prepare(agentId,accountId);
   let started=false;
   try{return await this.apply(agentId,accountId,()=>{started=true;});}
   catch(error){
     // Only a binding exactly as `prepare` left it is put back; anything else is a newer choice of another client.
     if(!started)await store.change(r=>{
       const b=r.bindings.find(b=>b.agentId===agentId);
       if(!b||b.pendingAccountId!==prepared.pendingAccountId||b.status!=="ready"||b.launchToken!==null)return;
       if(!before){r.bindings=r.bindings.filter(other=>other!==b);return;}
       b.pendingAccountId=before.pendingAccountId;b.status=before.status;b.error=before.error;b.launchToken=before.launchToken;
     }).catch(failure=>console.error(`Could not put back the account selection of agent ${agentId}: ${failure instanceof Error?failure.message:String(failure)}`));
     throw error;
   }
 }
 /** Binds a new agent to the default account, or to the next usable one when provider data shows the default would fail. */
 async bindNewAgent(agentId:string,provider:Provider,model:string|null=null):Promise<{accountId:string;defaultId:string;reason:Blocker|"sign-in"|"unverified"|null}|undefined>{
   const state=await this.deps.store.read();
   if(!state.integration.enabled||!state.integration.providers.includes(provider)||state.bindings.some(b=>b.agentId===agentId))return;
   const selected=state.defaults[provider];if(!selected)return;
   const account=accountFrom(state,selected);
   if(account.provider!==provider)throw new SwitchRefusal("The default account belongs to another provider.");
   if(account.loginToken)throw new SwitchRefusal("Default account sign-in is still in progress.");
   const usage=await this.deps.usage?.().catch(()=>[])??[];
   const evidence={defaultId:selected,accounts:state.accounts.filter(a=>a.provider===provider),usage,model,now:Date.now()};
   let chosen:string|undefined,defaultStatus:string|undefined;
   // With fallback off the default is binding, as before 0.7: the agent starts there or not at all.
   for(const id of state.fallback[provider]?launchOrder(evidence):[selected]){
     const {authStatus}=await this.deps.checkAccount(id);
     if(id===selected)defaultStatus=authStatus;
     if(authStatus==="ready"){chosen=id;break;}
   }
   if(!chosen)throw new SwitchRefusal("The default account requires authentication. Sign in or select another default account.");
   // Only the official probe's `needs_auth` means sign-in; a timeout or an unknown answer is reported as unverified.
   const reason=chosen===selected?null:defaultBlocker(evidence)??(defaultStatus==="needs_auth"?"sign-in":"unverified");
   if(reason)console.log(`New agent ${agentId}: the default ${provider} account would fail (${reason}); starting on account ${chosen}.`);
   const bound=await this.deps.store.change(r=>{
     if(!r.integration.enabled||!r.integration.providers.includes(provider)||r.bindings.some(b=>b.agentId===agentId))return;
     if(r.defaults[provider]!==selected)throw new SwitchRefusal("The default account changed; create the agent again.");
     if(accountFrom(r,chosen).loginToken)throw new SwitchRefusal("Account sign-in is still in progress.");
     r.bindings.push({agentId,provider,currentAccountId:null,pendingAccountId:null,launchAccountId:chosen,launchToken:randomUUID(),status:"ready",error:null,registrationObserved:false});
     return true;
   });
   return bound?{accountId:chosen,defaultId:selected,reason}:undefined;
 }
}
