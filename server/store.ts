import { readFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { AccountSchema, BindingSchema, type Provider, type AccountState } from "../shared/contracts";
import { atomicWrite, isMissing } from "./files";

export const StoredAccountSchema = AccountSchema.extend({ home: z.string(), identityKey: z.string().nullable(), generation: z.number().int(), loginToken:z.string().nullable().default(null) });
export type StoredAccount = z.infer<typeof StoredAccountSchema>;
const StoredBindingSchema = BindingSchema.extend({ launchAccountId: z.string().nullable(), launchToken: z.string().nullable(), registrationObserved:z.boolean().default(false) });
export type StoredBinding = z.infer<typeof StoredBindingSchema>;
const CommandsSchema = z.object({ claude: z.array(z.string()).nullable(), codex: z.array(z.string()).nullable() });
export const RegistrySchema = z.object({
 version: z.literal(1), accounts: z.array(StoredAccountSchema), bindings: z.array(StoredBindingSchema),
 defaults: z.object({claude:z.string().nullable(),codex:z.string().nullable()}),
 sourceHomes: z.object({claude:z.string(),codex:z.string()}),
 sourceEnvironment: z.object({claude:z.object({CLAUDE_CONFIG_DIR:z.string().optional(),CLAUDE_SECURESTORAGE_CONFIG_DIR:z.string().optional()}),codex:z.object({CODEX_HOME:z.string().optional()})}).default({claude:{},codex:{}}),
 commands: CommandsSchema, originalCommands: CommandsSchema,
 integration: z.object({enabled:z.boolean(),error:z.string().nullable()}),
});
export type Registry = z.infer<typeof RegistrySchema>;
export async function readRegistry(root: string): Promise<Registry> {
  return RegistrySchema.parse(JSON.parse(await readFile(join(root, "registry.json"), "utf8")));
}
export function accountFrom(registry: Registry, id: string): StoredAccount {
 const account = registry.accounts.find(a => a.id === id);
 if (!account) throw new Error("Account not found.");
 return account;
}
export class AccountStore {
 private queue: Promise<unknown> = Promise.resolve();
 constructor(readonly root: string) {}
 async initialize(sourceHomes: Registry["sourceHomes"]): Promise<void> {
   await mkdir(this.root, { recursive:true, mode:0o700 });
   try {
    await this.change(state => {
     for (const account of state.accounts) {
      const providerName = account.provider === "claude" ? "Claude" : "Codex";
      // Translate only the original generated label; preserve all user labels.
      if (account.source === "system" && account.label === `Поточний CLI · ${providerName}`) account.label = `Current CLI · ${providerName}`;
     }
    });
    return;
   } catch(error) { if(!isMissing(error)) throw new Error("The account registry is damaged; automatic recovery is disabled."); }
   const now = new Date().toISOString();
   await atomicWrite(join(this.root,"registry.json"),JSON.stringify({
    version:1, sourceHomes, accounts: (["claude","codex"] as const).map(provider=>({
     id:`system-${provider}`,provider,label:`Current CLI · ${provider === "claude"?"Claude":"Codex"}`,
     source:"system",home:sourceHomes[provider],email:null,plan:null,authStatus:"unknown",createdAt:now,identityKey:null,generation:0,
    })), bindings:[], defaults:{claude:null,codex:null}, commands:{claude:null,codex:null},originalCommands:{claude:null,codex:null},integration:{enabled:false,error:null},
   },null,2));
 }
 read(): Promise<Registry> { return readRegistry(this.root); }
 async change<T>(operation:(registry:Registry)=>T|Promise<T>): Promise<T> {
   const task=this.queue.catch(()=>{}).then(async()=>{const registry=await this.read();const before=JSON.stringify(registry);const value=await operation(registry);const validated=RegistrySchema.parse(registry);if(JSON.stringify(validated)!==before)await atomicWrite(join(this.root,"registry.json"),JSON.stringify(validated,null,2));return value;});
   this.queue=task; return task;
 }
 async snapshot():Promise<AccountState> {
   const state=await this.read();
   return { accounts:state.accounts.map(a=>AccountSchema.parse(a)),bindings:state.bindings.map(b=>BindingSchema.parse(b)),defaults:state.defaults,integration:state.integration };
 }
 async add(provider:Provider,label:string):Promise<StoredAccount> {
   return this.change(state=>{const account:StoredAccount={id:randomUUID(),provider,label:label.trim(),source:"managed",home:"",email:null,plan:null,authStatus:"needs_auth",createdAt:new Date().toISOString(),identityKey:null,generation:0,loginToken:null};account.home=join(this.root,"accounts",account.id,provider);state.accounts.push(account);return account;});
 }
 async remove(id:string,beforeRemove?:(account:StoredAccount,registry:Registry)=>Promise<void>):Promise<void> {
   await this.change(async state=>{const account=accountFrom(state,id);if(account.source==="system")throw new Error("The current CLI account cannot be removed.");if(state.bindings.some(b=>[b.currentAccountId,b.pendingAccountId,b.launchAccountId].includes(id))||Object.values(state.defaults).includes(id))throw new Error("The account is used by an agent or selected as the default.");await beforeRemove?.(account,state);state.accounts=state.accounts.filter(a=>a.id!==id);});
 }
 async prepare(agentId:string,provider:Provider,accountId:string|null):Promise<StoredBinding> {
   return this.change(state=>{
     if(accountId&&accountFrom(state,accountId).provider!==provider)throw new Error("The account belongs to another provider.");
     let binding=state.bindings.find(b=>b.agentId===agentId);
     if(!binding){binding={agentId,provider,currentAccountId:`system-${provider}`,pendingAccountId:null,status:"ready",error:null,launchAccountId:`system-${provider}`,launchToken:null,registrationObserved:true};state.bindings.push(binding);}
     if(binding.status==="switching")throw new Error("An account switch is already in progress.");
     binding.pendingAccountId=accountId===binding.currentAccountId?null:accountId;binding.error=null;binding.status="ready";binding.launchToken=null;binding.registrationObserved=true;return binding;
   });
 }
 async updateIdentity(id:string,update:Pick<StoredAccount,"identityKey"|"email"|"plan"|"authStatus">,expected?:Pick<StoredAccount,"generation"|"loginToken">):Promise<StoredAccount> {
   return this.change(state=>{const account=accountFrom(state,id);if(expected&&(account.generation!==expected.generation||account.loginToken!==expected.loginToken))return account;if(account.identityKey!==update.identityKey)account.generation++;Object.assign(account,update);return account;});
 }
}
