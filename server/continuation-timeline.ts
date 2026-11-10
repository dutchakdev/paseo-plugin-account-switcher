import { z } from "zod";
import type { PaseoApi } from "./paseo-api";

const Cursor=z.object({epoch:z.string(),seq:z.number().int().nonnegative()});
const Entry=z.object({provider:z.string(),turnId:z.string().optional(),item:z.unknown(),seqStart:z.number().int().nonnegative(),seqEnd:z.number().int().nonnegative()});
const Payload=z.object({
 agentId:z.string(),direction:z.enum(["tail","before"]),projection:z.enum(["canonical","projected"]),epoch:z.string(),
 hasNewer:z.boolean(),hasOlder:z.boolean(),startCursor:Cursor.nullable(),
 reset:z.literal(false),staleCursor:z.literal(false),gap:z.literal(false),error:z.null(),entries:z.array(Entry),
});
const Assistant=z.object({type:z.literal("assistant_message"),messageId:z.string().min(1).max(512).refine(id=>!/[\x00-\x20\x7f]/.test(id))});
const typeOf=(entry:z.infer<typeof Entry>)=>typeof entry.item==="object"&&entry.item!==null?(entry.item as {type?:unknown}).type:null;
type Terminal={kind:"found";id:string}|{kind:"absent"}|{kind:"invalid"};
function terminalAssistant(entries:z.infer<typeof Entry>[],turnId:string):Terminal{
 if(entries.some(entry=>entry.seqEnd<entry.seqStart))return{kind:"invalid"};
 const assistants=entries.filter(entry=>typeOf(entry)==="assistant_message");
 if(!assistants.length)return{kind:"absent"};
 const last=Math.max(...assistants.map(entry=>entry.seqEnd));
 const terminal=assistants.filter(entry=>entry.seqEnd===last);
 if(terminal.some(entry=>entry.provider!=="claude"||entry.turnId!==turnId))return{kind:"invalid"};
 const messages=terminal.map(entry=>Assistant.safeParse(entry.item));
 if(messages.some(result=>!result.success))return{kind:"invalid"};
 const ids=new Set(messages.map(result=>result.success?result.data.messageId:""));
 if(ids.size!==1||entries.some(entry=>typeOf(entry)==="user_message"&&entry.seqEnd>=last))return{kind:"invalid"};
 return{kind:"found",id:[...ids][0]!};
}
/** Native terminal assistant message ID, not a user/client ID or transcript prose.
 * Paseo 0.15.4 hardcodes projected replies even to canonical requests. Its projector
 * preserves separate assistant entries with distinct explicit IDs. The manager rewrites
 * user IDs, but leaves these assistant IDs intact. Missing terminal identity fails closed;
 * never look back to an earlier assistant error after a later assistant or user message. */
export function claudeTurnMessageId(payload:unknown,agentId:string,turnId:string):string|null {
 const parsed=Payload.safeParse(payload);if(!parsed.success||parsed.data.agentId!==agentId||parsed.data.direction!=="tail"||parsed.data.hasNewer)return null;
 const result=terminalAssistant(parsed.data.entries,turnId);
 return result.kind==="found"?result.id:null;
}
/** At most 20 requested canonical pages / 2000 entries; accepts 0.15.4 projected replies.
 * Only if the tail has no assistant do we page backwards. No body text is inspected or saved. */
export async function readClaudeTurnMessageId(paseo:PaseoApi,agentId:string,turnId:string,check:()=>void=()=>{}):Promise<string|null>{
 const timeline=paseo.agents.ref(agentId).timeline,entries:z.infer<typeof Entry>[]=[];
 let epoch:string|undefined,cursor:z.infer<typeof Cursor>|undefined;
 const seen=new Set<number>();
 for(let page=0;page<20;page++){
  check();
  const payload=await timeline.refetch({direction:page===0?"tail":"before",limit:100,projection:"canonical",...(cursor?{cursor}:{})});
  check();
  const parsed=Payload.safeParse(payload);if(!parsed.success)return null;
  const data=parsed.data;
  if(data.agentId!==agentId||data.direction!==(page===0?"tail":"before")||(page===0&&data.hasNewer)||epoch&&data.epoch!==epoch||data.entries.length>100)return null;
  if(data.hasOlder&&(!data.startCursor||data.startCursor.epoch!==data.epoch||seen.has(data.startCursor.seq)||cursor&&data.startCursor.seq>=cursor.seq))return null;
  epoch=data.epoch;entries.push(...data.entries);
  const result=terminalAssistant(entries,turnId);
  if(result.kind!=="absent")return result.kind==="found"?result.id:null;
  if(!data.hasOlder||!data.startCursor||data.startCursor.epoch!==epoch||seen.has(data.startCursor.seq)||cursor&&data.startCursor.seq>=cursor.seq)return null;
  seen.add(data.startCursor.seq);cursor=data.startCursor;
 }
 return null;
}
