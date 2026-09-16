import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BindingSchema, type Binding, type Provider } from "../shared/contracts";
import { AccountStore, accountFrom, type StoredBinding } from "./store";

export interface SwitchDependencies {
 store:AccountStore;
 inspect:(agentId:string)=>Promise<{provider:string;busy:boolean;archived:boolean}>;
 checkAccount:(accountId:string)=>Promise<{authStatus:string}>;
 reload:(agentId:string)=>Promise<void>;
 applying?:Set<string>;
}
export class SwitchService {
 private applying:Set<string>;
 constructor(private readonly deps:SwitchDependencies){this.applying=deps.applying??new Set();}
 async prepare(agentId:string,accountId:string|null):Promise<Binding>{
   if(this.applying.has(agentId))throw new Error("An account switch is already in progress.");
   const agent=await this.deps.inspect(agentId);
   if(agent.archived)throw new Error("The agent is archived.");
   if(agent.provider!=="claude"&&agent.provider!=="codex")throw new Error("Only Claude and Codex are supported.");
   return BindingSchema.parse(await this.deps.store.prepare(agentId,agent.provider,accountId));
 }
 async apply(agentId:string):Promise<Binding>{
   if(this.applying.has(agentId))throw new Error("An account switch is already in progress.");
   this.applying.add(agentId);
   let previous:StoredBinding|undefined;
   const token=randomUUID();
   try {
     const {store}=this.deps, state=await store.read();
     if(!state.integration.enabled)throw new Error("Enable account integration first.");
     const selected=state.bindings.find(b=>b.agentId===agentId);
     if(!selected?.pendingAccountId)throw new Error("Select an account first.");
     const target=accountFrom(state,selected.pendingAccountId);
     if(target.loginToken)throw new Error("Finish signing in to the selected account first.");
     const assertIdle=async()=>{const agent=await this.deps.inspect(agentId);if(agent.archived)throw new Error("The agent is archived.");if(agent.provider!==target.provider)throw new Error("The agent provider changed.");if(agent.busy)throw new Error("Wait for the agent to finish its response.");};
     await assertIdle();
     if((await this.deps.checkAccount(target.id)).authStatus!=="ready")throw new Error("Sign in to the selected account first.");
     await assertIdle();
     previous=await store.change(r=>{const b=r.bindings.find(b=>b.agentId===agentId);if(!r.integration.enabled||!b||b.pendingAccountId!==target.id||b.status==="switching")throw new Error("The account selection changed; try again.");if(accountFrom(r,target.id).loginToken)throw new Error("Account sign-in is still in progress.");const old=structuredClone(b);b.status="switching";b.error=null;b.launchAccountId=target.id;b.launchToken=token;return old;});
     await this.deps.reload(agentId);
     const receipt=JSON.parse(await readFile(join(store.root,"receipts",encodeURIComponent(agentId)+".json"),"utf8"));
     if(receipt.accountId!==target.id||receipt.launchToken!==token)throw new Error("The new account did not confirm its launch.");
     return await store.change(r=>{const b=r.bindings.find(b=>b.agentId===agentId);if(!r.integration.enabled||!b||b.launchToken!==token)throw new Error("The account switch state changed.");b.currentAccountId=target.id;b.pendingAccountId=null;b.status="ready";b.error=null;b.launchToken=null;b.registrationObserved=true;return BindingSchema.parse(b);});
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
           const receipt=JSON.parse(await readFile(join(this.deps.store.root,"receipts",encodeURIComponent(agentId)+".json"),"utf8"));
           restored=receipt.accountId===rollback.currentAccountId&&receipt.launchToken===rollbackToken;
         }catch{/* Keep the account unknown unless rollback launch is confirmed. */}
       }
       await this.deps.store.change(r=>{const b=r.bindings.find(b=>b.agentId===agentId);if(b?.launchToken===rollbackToken){b.currentAccountId=restored?rollback.currentAccountId:null;b.pendingAccountId=rollback.pendingAccountId;b.status="error";b.launchToken=null;b.error=restored?"The account switch failed. The previous account was restored.":"Account not confirmed for the running session. Select an account and apply it again.";}});
     }
     throw error;
   } finally {this.applying.delete(agentId);}
 }
 async bindNewAgent(agentId:string,provider:Provider):Promise<void>{
   const state=await this.deps.store.read();
   if(!state.integration.enabled||state.bindings.some(b=>b.agentId===agentId))return;
   const selected=state.defaults[provider];if(!selected)return;
   const account=accountFrom(state,selected);
   if(account.provider!==provider)throw new Error("The default account belongs to another provider.");
   if(account.loginToken)throw new Error("Default account sign-in is still in progress.");
   if((await this.deps.checkAccount(selected)).authStatus!=="ready")throw new Error("The default account requires authentication. Sign in or select another default account.");
   await this.deps.store.change(r=>{
     if(!r.integration.enabled||r.bindings.some(b=>b.agentId===agentId))return;
     const accountId=r.defaults[provider];if(accountId!==selected)throw new Error("The default account changed; create the agent again.");
     if(accountFrom(r,accountId).loginToken)throw new Error("Default account sign-in is still in progress.");
     r.bindings.push({agentId,provider,currentAccountId:null,pendingAccountId:null,launchAccountId:accountId,launchToken:randomUUID(),status:"ready",error:null,registrationObserved:false});
   });
 }
}
