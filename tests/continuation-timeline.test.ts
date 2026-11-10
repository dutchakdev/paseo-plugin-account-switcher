import { describe, expect, it, vi } from "vitest";
import { claudeTurnMessageId, readClaudeTurnMessageId } from "../server/continuation-timeline";
import type { PaseoApi } from "../server/paseo-api";
const ID="msg_native_terminal",OTHER="msg_other";
const assistant=(seq:number,turnId="turn",messageId:string|undefined=ID)=>({provider:"claude",turnId,seqStart:seq,seqEnd:seq,item:{type:"assistant_message",text:"not inspected",messageId}});
const user=(seq:number,turnId="turn",messageId="client-user-id")=>({provider:"claude",turnId,seqStart:seq,seqEnd:seq,item:{type:"user_message",text:"not inspected",messageId}});
const payload=(entries:unknown[])=>({agentId:"agent",direction:"tail",projection:"projected",hasNewer:false,hasOlder:false,epoch:"epoch",startCursor:null,reset:false,staleCursor:false,gap:false,error:null,entries});
describe("current-turn native terminal assistant ID",()=>{
 it.each(["canonical","projected"])("accepts the final explicit native ID from %s, independently of rewritten user IDs",async projection=>{
  const response={...payload([user(1),assistant(2),assistant(3)]),projection};
  const refetch=vi.fn(async()=>response),paseo={agents:{ref:()=>({timeline:{refetch}})}} as unknown as PaseoApi;
  expect(claudeTurnMessageId(response,"agent","turn")).toBe(ID);
  expect(await readClaudeTurnMessageId(paseo,"agent","turn")).toBe(ID);
  expect(refetch).toHaveBeenCalledWith({direction:"tail",limit:100,projection:"canonical"});
 });
 it("keeps projected assistants with distinct explicit IDs separate and picks the last",()=>{
  expect(claudeTurnMessageId(payload([assistant(2,"turn","msg_old_error"),assistant(3,"turn","msg_normal_answer")]),"agent","turn")).toBe("msg_normal_answer");
 });
 it("never falls back to an earlier valid error ID when the last assistant has no identity",async()=>{
  const response={...payload([assistant(1),{...assistant(2),item:{type:"assistant_message",text:"later"}}]),hasOlder:true,startCursor:{epoch:"epoch",seq:1}};
  const refetch=vi.fn(async()=>response),paseo={agents:{ref:()=>({timeline:{refetch}})}} as unknown as PaseoApi;
  expect(await readClaudeTurnMessageId(paseo,"agent","turn")).toBeNull();expect(refetch).toHaveBeenCalledTimes(1);
 });
 it.each([
  [],[user(1)],[assistant(1,"old")],[{...assistant(1),provider:"codex"}],
  [assistant(1),user(2,"new")],[assistant(1),user(1)],[assistant(1),assistant(1,"turn",OTHER)],
  [{...assistant(1),turnId:undefined}],[{...assistant(1),item:{type:"assistant_message",clientMessageId:ID}}],
  [assistant(1,"turn","")],[assistant(1,"turn","x".repeat(513))],[assistant(1,"turn","line\nbreak")],
  [{...assistant(1),seqStart:2,seqEnd:1}],
 ].map(entries=>({entries})))("rejects missing, old, ambiguous, later-user or client-only identities (%#)",({entries})=>{
  expect(claudeTurnMessageId(payload(entries),"agent","turn")).toBeNull();
 });
 it.each([{hasNewer:true},{gap:true},{staleCursor:true},{projection:"unknown"},{agentId:"other"},{error:"unavailable"}])("rejects incomplete or unknown-projection payload %j",changes=>{
  expect(claudeTurnMessageId({...payload([assistant(1)]),...changes},"agent","turn")).toBeNull();
 });
 it("does not page backwards once the final assistant is known",async()=>{
  const response={...payload([assistant(150)]),hasOlder:true,startCursor:{epoch:"epoch",seq:150}};
  const refetch=vi.fn(async()=>response),paseo={agents:{ref:()=>({timeline:{refetch}})}} as unknown as PaseoApi;
  expect(await readClaudeTurnMessageId(paseo,"agent","turn")).toBe(ID);expect(refetch).toHaveBeenCalledTimes(1);
 });
 it("reads older pages only when the tail has no assistant",async()=>{
  const first={...payload([{...assistant(150),item:{type:"reasoning"}}]),hasOlder:true,startCursor:{epoch:"epoch",seq:150}};
  const second={...payload([user(1),assistant(100)]),direction:"before",hasNewer:true,hasOlder:true,startCursor:{epoch:"epoch",seq:1}};
  const refetch=vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),check=vi.fn();
  const paseo={agents:{ref:()=>({timeline:{refetch}})}} as unknown as PaseoApi;
  expect(await readClaudeTurnMessageId(paseo,"agent","turn",check)).toBe(ID);
  expect(refetch.mock.calls[1][0]).toEqual({direction:"before",limit:100,projection:"canonical",cursor:{epoch:"epoch",seq:150}});expect(check).toHaveBeenCalledTimes(4);
 });
 it("does not resurrect an older assistant when the read tail contains a newer user",async()=>{
  const first={...payload([user(150)]),hasOlder:true,startCursor:{epoch:"epoch",seq:150}};
  const second={...payload([assistant(100)]),direction:"before",hasNewer:true};
  const refetch=vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),paseo={agents:{ref:()=>({timeline:{refetch}})}} as unknown as PaseoApi;
  expect(await readClaudeTurnMessageId(paseo,"agent","turn")).toBeNull();
 });
 it.each(["epoch","reset","loop"])("rejects pagination %s changes",async mode=>{
  const first={...payload([]),hasOlder:true,startCursor:{epoch:"epoch",seq:150}};
  const second={...payload([assistant(100)]),direction:"before",hasNewer:true,hasOlder:true,startCursor:{epoch:"epoch",seq:mode==="loop"?150:1},...(mode==="epoch"?{epoch:"other"}:{}),...(mode==="reset"?{reset:true}:{})};
  const refetch=vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),paseo={agents:{ref:()=>({timeline:{refetch}})}} as unknown as PaseoApi;
  expect(await readClaudeTurnMessageId(paseo,"agent","turn")).toBeNull();
 });
 it("bounds missing-assistant scans and stops when activity changes",async()=>{
  let count=0;const refetch=vi.fn(async()=>({...payload([]),direction:count===0?"tail":"before",hasOlder:true,startCursor:{epoch:"epoch",seq:10000-(++count)}}));
  const paseo={agents:{ref:()=>({timeline:{refetch}})}} as unknown as PaseoApi;
  expect(await readClaudeTurnMessageId(paseo,"agent","turn")).toBeNull();expect(refetch).toHaveBeenCalledTimes(20);
  refetch.mockClear();count=0;let calls=0;
  await expect(readClaudeTurnMessageId(paseo,"agent","turn",()=>{if(++calls===2)throw new Error("new activity");})).rejects.toThrow("new activity");expect(refetch).toHaveBeenCalledTimes(1);
 });
});
