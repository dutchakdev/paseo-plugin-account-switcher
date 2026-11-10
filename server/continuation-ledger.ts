import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, isMissing } from "./files";

const OperationSchema = z.object({
 key:z.string(), rowId:z.string(), agentId:z.string(), sessionId:z.string(), turnId:z.string(), provider:z.enum(["claude","codex"]),
 fromId:z.string(), toId:z.string().nullable(), fromIdentity:z.string(), toIdentity:z.string().nullable(),
 createdAt:z.number(), attemptedAt:z.number().nullable(), updatedAt:z.number(),
 state:z.enum(["intent","switching","sending","finished","uncertain"]), messageId:z.string(),
 resumes:z.literal(true), resetsAt:z.string().nullable(), errorId:z.string().nullable(), userId:z.string().nullable(),
});
export type ContinuationOperation = z.infer<typeof OperationSchema>;
const Schema = z.object({version:z.literal(1),operations:z.array(OperationSchema)});
export interface OperationLedger {
 read():Promise<ContinuationOperation[]>;
 add(operation:ContinuationOperation):Promise<boolean>;
 update(key:string,state:ContinuationOperation["state"],at:number):Promise<void>;
}
/** One writer per plugin process, atomic 0600 files. An interrupted process never replays an intent or send. */
export class ContinuationLedger implements OperationLedger {
 private queue:Promise<unknown> = Promise.resolve();
 private readonly path:string;
 private loaded:Promise<ContinuationOperation[]> | undefined;
 constructor(root:string){this.path=join(root,"continuation-ledger.json");}
 private load():Promise<ContinuationOperation[]> {
  this.loaded ??= (async()=>{
   let operations:ContinuationOperation[];
   try{operations=Schema.parse(JSON.parse(await readFile(this.path,"utf8"))).operations;}
   catch(error){if(!isMissing(error))throw new Error("Recovery journal is unavailable; use /account.");operations=[];}
   let changed=false;
   for(const op of operations)if(op.state!=="finished"&&op.state!=="uncertain"){op.state="uncertain";op.updatedAt=Date.now();changed=true;}
   if(changed)await atomicWrite(this.path,JSON.stringify({version:1,operations}),0o600);
   return operations;
  })();
  return this.loaded;
 }
 private mutate<T>(operation:(operations:ContinuationOperation[])=>T):Promise<T>{
  const next=this.queue.then(async()=>{
   const operations=structuredClone(await this.load());
   const result=operation(operations);
   await atomicWrite(this.path,JSON.stringify({version:1,operations}),0o600);
   this.loaded=Promise.resolve(operations);
   return result;
  });
  // A failed write poisons this instance. It must never act on undurable state.
  this.queue=next;
  return next;
 }
 async read(){await this.queue;return structuredClone(await this.load());}
 add(operation:ContinuationOperation){return this.mutate(operations=>{if(operations.some(op=>op.key===operation.key||op.rowId===operation.rowId))return false;operations.push(OperationSchema.parse(operation));return true;});}
 update(key:string,state:ContinuationOperation["state"],at:number){return this.mutate(operations=>{const op=operations.find(op=>op.key===key);if(!op)throw new Error("Recovery journal entry missing.");op.state=state;op.updatedAt=at;if(state==="switching")op.attemptedAt=at;});}
}
