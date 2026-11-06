import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { Account, AccountState } from "../shared/contracts";

const fixture=vi.hoisted(()=>{
  let slots:unknown[]=[],index=0;
  return {
    reset(){slots=[];index=0;},render(){index=0;},
    useState<T>(initial:T){const slot=index++;if(!(slot in slots))slots[slot]=initial;return [slots[slot] as T,(next:T)=>{slots[slot]=next;}] as const;},
    rpc:vi.fn(),runs:[] as Promise<unknown>[],
  };
});
vi.mock("react",async original=>({...await original<typeof import("react")>(),useState:fixture.useState,useEffect:()=>{}}));
vi.mock("react-native",()=>({View:"View",Text:"Text",TextInput:"TextInput",Pressable:"Pressable"}));
vi.mock("@getpaseo/plugin/client",()=>({useRpc:(contract:{name:string})=>(input:unknown)=>fixture.rpc(contract.name,input)}));
vi.mock("@getpaseo/plugin/client/react-native",()=>({Icon:"Icon",Modal:Object.assign(()=>null,{Content:()=>null})}));
vi.mock("@getpaseo/plugin/client/ui",()=>({SettingsCard:"SettingsCard",SettingsSwitch:"SettingsSwitch",SettingsAction:"SettingsAction"}));
vi.mock("../client/data",()=>({useAction:()=>({isPending:false,error:null,run:(action:()=>Promise<unknown>)=>{fixture.runs.push(action());}})}));
const {AccountCard}=await import("../client/account-card");
const {Button}=await import("../client/components");

type Node=ReactElement<{children?:unknown;label?:string;disabled?:boolean;onPress?():void}>;
function elements(node:unknown):Node[]{
  if(Array.isArray(node))return node.flatMap(elements);
  if(!node||typeof node!=="object"||!("props" in node))return [];
  const element=node as Node;return [element,...elements(element.props.children)];
}
function button(tree:unknown,label:string){return elements(tree).find(e=>e.type===Button&&(e.props.label===label||e.props.children===label))!;}
function text(tree:unknown){return elements(tree).flatMap(e=>[e.props.children].flat()).filter(c=>typeof c==="string").join(" ");}
const account:Account={id:"work",provider:"claude",source:"managed",label:"Work",email:null,plan:null,authStatus:"ready",createdAt:"2026-11-06",login:null};
function mount(compact=false,source:Account["source"]="managed"){
  const state={defaults:{claude:"work",codex:null},bindings:[]} as unknown as AccountState;
  const props={account:{...account,source},state,snapshot:undefined,checksOff:false,now:Date.now(),theme:{colors:{}},layout:{compact},host:{id:"host"},onChanged:vi.fn(),onStarted:vi.fn(),onResume:vi.fn()};
  const render=()=>{fixture.render();return AccountCard(props as never);};
  return {render,props};
}
beforeEach(()=>{fixture.reset();fixture.rpc.mockReset().mockResolvedValue({});fixture.runs.length=0;});

describe("account actions",()=>{
  it.each([false,true])("shows removal directly and requires confirmation with compact=%s",async compact=>{
    const {render,props}=mount(compact);
    button(render(),"Remove Work").props.onPress!();
    expect(text(render())).toContain("Clear this account’s default first.");
    expect(button(render(),"Remove account").props.disabled).toBe(true);
    button(render(),"Clear default").props.onPress!();
    await Promise.all(fixture.runs);
    expect(fixture.rpc).toHaveBeenCalledExactlyOnceWith("accounts.default",{provider:"claude",accountId:null});
    props.state.defaults.claude=null;
    expect(button(render(),"Remove account").props.disabled).toBe(false);
    button(render(),"Cancel").props.onPress!();
    expect(fixture.rpc.mock.calls.some(([name])=>name==="accounts.remove")).toBe(false);
    button(render(),"Remove Work").props.onPress!();
    button(render(),"Remove account").props.onPress!();
    await Promise.all(fixture.runs);
    expect(fixture.rpc).toHaveBeenLastCalledWith("accounts.remove",{accountId:"work"});
  });
  it("explains why a host CLI account cannot be removed",()=>{
    const {render}=mount(false,"system");
    expect(button(render(),"Remove Work")).toBeUndefined();
    button(render(),"Manage Work").props.onPress!();
    expect(text(render())).toContain("it cannot be removed here");
    expect(button(render(),"Remove account")).toBeUndefined();
  });
  it("lets an inaccessible account be checked again without starting browser sign-in",async()=>{
    const {render,props}=mount(false,"system");
    props.account.authStatus="error";
    fixture.rpc.mockResolvedValue({...props.account,authStatus:"ready"});
    button(render(),"Check sign-in").props.onPress!();
    await Promise.all(fixture.runs);
    expect(fixture.rpc).toHaveBeenCalledExactlyOnceWith("auth.check",{accountId:"work"});
    expect(text(render())).toContain("Sign-in confirmed.");
    expect(text(render())).not.toContain("Finish signing in in your browser");
  });
});
