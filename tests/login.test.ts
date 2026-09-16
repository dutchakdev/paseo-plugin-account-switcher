import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { LoginSessions } from "../server/login";
import { AccountStore } from "../server/store";
import { AccountController } from "../server/controller";
import type { LoginProcessOptions } from "../server/login-process";

const boundaries=vi.hoisted(()=>({probe:vi.fn()}));
vi.mock("../server/auth",async original=>({...await original<typeof import("../server/auth")>(),probeAccount:boundaries.probe}));
vi.mock("../server/usage",async original=>({...await original<typeof import("../server/usage")>(),createUsageService:()=>({start:vi.fn(),close:vi.fn(async()=>{}),invalidate:vi.fn(),refresh:vi.fn(async()=>[]),list:vi.fn(async()=>[])})}));
const roots:string[]=[],closers:Array<()=>Promise<void>>=[];
beforeEach(()=>{boundaries.probe.mockReset().mockResolvedValue({identityKey:"fixture-account",email:"fixture@example.test",plan:"plus",authStatus:"ready"});});
afterEach(async()=>{await Promise.allSettled(closers.splice(0).map(close=>close()));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

function transport(){
 const calls:LoginProcessOptions[]=[];
 const start=vi.fn(),write=vi.fn(),stop=vi.fn(async(code=1)=>{calls.at(-1)!.onExit(code,true);});
 const createProcess=vi.fn((options:LoginProcessOptions)=>{calls.push(options);return{ready:async()=>{},start,write,stop};});
 return{calls,start,write,stop,createProcess,data:(data:unknown)=>calls.at(-1)!.onData("stdout",typeof data==="string"?data:JSON.stringify(data)+"\n")};
}
async function fixture(provider:"claude"|"codex"="codex",timeoutMs?:number){
 const root=await mkdtemp(join(tmpdir(),"account-browser-login-"));roots.push(root);
 const store=new AccountStore(root);await store.initialize({claude:join(root,"source-claude"),codex:join(root,"source-codex")});
 await store.change(state=>{state.commands={claude:[process.execPath],codex:[process.execPath]};});
 const account=await store.add(provider,"Fixture account");await mkdir(account.home,{recursive:true});
 const fake=transport(),finish=vi.fn(async()=>true),sessions=new LoginSessions({createProcess:fake.createProcess,timeoutMs,finish});closers.push(()=>sessions.close());
 await sessions.start(account,await store.read(),root,"attempt-one");
 return{root,store,account,fake,finish,sessions};
}
const claudeUrl="https://claude.com/cai/oauth/authorize?state=fixture-state&code_challenge=fixture-challenge&response_type=code";
const initialize={id:1,result:{userAgent:"fixture"}};
const device={id:2,result:{type:"chatgptDeviceCode",loginId:"native-one",verificationUrl:"https://auth.openai.com/codex/device",userCode:"ABCD-1234"}};
const done={method:"account/login/completed",params:{loginId:"native-one",success:true,error:null}};

it("keeps a split Claude URL private until its final delimiter and accepts only the matching full code",async()=>{
 const f=await fixture("claude");
 const prefix=claudeUrl.indexOf("challenge")+12;
 f.fake.data("If the browser did not open, visit: "+claudeUrl.slice(0,prefix));
 expect(f.sessions.status(f.account.id,"attempt-one")).toMatchObject({status:"starting",authorizationUrl:null});
 f.fake.data(claudeUrl.slice(prefix));
 expect(f.sessions.status(f.account.id,"attempt-one").authorizationUrl).toBeNull();
 f.fake.data("\nPaste code here if prompted > ");
 expect(f.sessions.status(f.account.id,"attempt-one")).toMatchObject({mode:"browser",status:"waiting",authorizationUrl:claudeUrl,canSubmitCode:true});
 expect(()=>f.sessions.submit(f.account.id,"old-attempt","auth-code#fixture-state")).toThrow(/no longer active/);
 expect(()=>f.sessions.submit(f.account.id,"attempt-one","auth-code#wrong-state")).toThrow(/complete sign-in code/);
 expect(()=>f.sessions.submit(f.account.id,"attempt-one","auth-code#fixture-state\nsecond-line")).toThrow();
 expect(f.sessions.submit(f.account.id,"attempt-one","auth-code#fixture-state").status).toBe("verifying");
 expect(f.fake.write).toHaveBeenCalledWith("auth-code#fixture-state\n");
 f.fake.calls[0].onExit(0,true);
 await vi.waitFor(()=>expect(f.sessions.status(f.account.id,"attempt-one")).toMatchObject({status:"complete",authorizationUrl:null,userCode:null,canSubmitCode:false}));
 expect(f.fake.calls[0].env.BROWSER).toBe("/usr/bin/true");
 expect(f.fake.calls[0].args).toEqual(["auth","login","--claudeai"]);
});

it("uses the official Codex handshake and matches completion IDs, including a notification before the start response",async()=>{
 const f=await fixture();
 expect(JSON.parse(f.fake.write.mock.calls[0][0])).toMatchObject({method:"initialize",params:{capabilities:null}});
 f.fake.data(initialize);
 expect(f.fake.write).toHaveBeenCalledWith(JSON.stringify({id:2,method:"account/login/start",params:{type:"chatgptDeviceCode"}})+"\n");
 f.fake.data({method:"account/login/completed",params:{loginId:"another-native",success:true}});
 f.fake.data(done);expect(f.finish).not.toHaveBeenCalled();
 f.fake.data(device);
 await vi.waitFor(()=>expect(f.sessions.status(f.account.id,"attempt-one").status).toBe("complete"));
 expect(f.fake.stop).toHaveBeenCalledWith(0);expect(f.finish).toHaveBeenCalledWith(f.account.id,"attempt-one",true);
 expect(f.sessions.status(f.account.id,"attempt-one")).toMatchObject({authorizationUrl:null,userCode:null});
});

it("shows the device code only while waiting and requires a fresh native account probe after success",async()=>{
 const f=await fixture();f.finish.mockResolvedValue(false);f.fake.data(initialize);f.fake.data(device);
 expect(f.sessions.status(f.account.id,"attempt-one")).toMatchObject({status:"waiting",userCode:"ABCD-1234",canSubmitCode:false});
 expect(()=>f.sessions.submit(f.account.id,"attempt-one","anything")).toThrow(/not waiting for a code/);
 f.fake.data(done);await vi.waitFor(()=>expect(f.sessions.status(f.account.id,"attempt-one")).toMatchObject({status:"error",authorizationUrl:null,userCode:null}));
});

it.each(["https://auth.openai.com.evil.test/device","https://auth.openai.com/unrelated","https://user@auth.openai.com/codex/device","https://auth.openai.com:9443/codex/device","https://auth.openai.com/codex/device\n"])("rejects unsafe device authorization URL %s",async url=>{
 const f=await fixture();f.fake.data(initialize);
 f.fake.data({...device,result:{...device.result,verificationUrl:url}});
 await vi.waitFor(()=>expect(f.sessions.status(f.account.id,"attempt-one").status).toBe("error"));
 expect(f.sessions.status(f.account.id,"attempt-one").authorizationUrl).toBeNull();
 expect(f.fake.stop).toHaveBeenCalled();
});

it("returns the official Codex browser URL without starting a terminal or accepting manual codes",async()=>{
 const f=await fixture();await f.sessions.cancel(f.account.id,"attempt-one");
 await f.sessions.start(f.account,await f.store.read(),f.root,"browser-attempt","browser");f.fake.data(initialize);
 expect(f.fake.write).toHaveBeenCalledWith(JSON.stringify({id:2,method:"account/login/start",params:{type:"chatgpt"}})+"\n");
 const authorizationUrl="https://auth.openai.com/oauth/authorize?state=fixture&code_challenge=fixture";
 f.fake.data({id:2,result:{type:"chatgpt",loginId:"browser-native",authUrl:authorizationUrl}});
 expect(f.sessions.status(f.account.id,"browser-attempt")).toMatchObject({mode:"browser",status:"waiting",authorizationUrl,userCode:null,canSubmitCode:false});
});

it("extracts a complete Claude URL from the official terminal hyperlink format",async()=>{
 const f=await fixture("claude");
 f.fake.data("Visit: \x1b]8;;"+claudeUrl+"\x1b\\"+claudeUrl+"\x1b]8;;\x1b\\\n");
 expect(f.sessions.status(f.account.id,"attempt-one")).toMatchObject({authorizationUrl:claudeUrl,status:"waiting"});
});

it("caps login time and stops the process before calling completion",async()=>{
 const f=await fixture("claude",20);f.fake.data(claudeUrl+"\n");
 await vi.waitFor(()=>expect(f.fake.stop).toHaveBeenCalled());
 expect(f.sessions.status(f.account.id,"attempt-one")).toMatchObject({status:"error",error:"Sign-in expired. Start sign-in again.",authorizationUrl:null});
 expect(f.finish).toHaveBeenCalledWith(f.account.id,"attempt-one",false);
});

async function controllerFixture(){
 const root=await mkdtemp(join(tmpdir(),"account-login-controller-"));roots.push(root);
 const fake=transport(),controller=new AccountController(root,{createProcess:fake.createProcess});closers.push(()=>controller.close());await controller.ready;
 await controller.store.change(state=>{state.sourceHomes={claude:join(root,"source-claude"),codex:join(root,"source-codex")};state.commands={claude:[process.execPath],codex:[process.execPath]};});
 const account=await controller.add("codex","Fixture account");
 const paseo={} as PaseoApi;
 return{root,fake,controller,account,paseo};
}

it("reserves before native launch, keeps URLs out of registry, and clears state only after native exit and identity verification",async()=>{
 const f=await controllerFixture();
 f.fake.start.mockImplementation(()=>{expect(f.fake.calls).toHaveLength(1);});
 const session=await f.controller.startLogin(f.paseo,f.account.id);
 expect((await f.controller.store.read()).accounts.find(a=>a.id===f.account.id)).toMatchObject({loginToken:session.id,login:{sessionId:session.id,mode:"device"}});
 f.fake.data(initialize);f.fake.data(device);
 expect(await f.controller.getLoginStatus(f.account.id,session.id)).toMatchObject({authorizationUrl:device.result.verificationUrl,userCode:device.result.userCode});
 const bytes=await readFile(join(f.root,"registry.json"),"utf8");expect(bytes).not.toContain("ABCD-1234");expect(bytes).not.toContain("auth.openai.com");
 f.fake.data(done);
 await vi.waitFor(async()=>expect(await f.controller.getLoginStatus(f.account.id,session.id)).toMatchObject({status:"complete",authorizationUrl:null,userCode:null}));
 expect((await f.controller.store.read()).accounts.find(a=>a.id===f.account.id)).toMatchObject({loginToken:null,login:null,authStatus:"ready"});
 expect(boundaries.probe).toHaveBeenCalled();
});

it("preserves the login reservation if shutdown cannot be confirmed during startup",async()=>{
 const f=await controllerFixture();f.fake.write.mockImplementation(()=>{throw new Error("fixture startup failure");});f.fake.stop.mockRejectedValue(new Error("fixture shutdown unconfirmed"));
 await expect(f.controller.startLogin(f.paseo,f.account.id)).rejects.toThrow();
 const pending=(await f.controller.store.read()).accounts.find(a=>a.id===f.account.id)!;
 expect(pending.loginToken).toBeTruthy();expect(pending.login).toHaveProperty("sessionId",pending.loginToken);
 await expect(f.controller.startLogin(f.paseo,f.account.id)).rejects.toThrow(/already open/);
 await expect(f.controller.cancelLogin(f.paseo,f.account.id,pending.loginToken!)).rejects.toThrow();
 expect((await f.controller.store.read()).accounts.find(a=>a.id===f.account.id)?.loginToken).toBe(pending.loginToken);
});

it("rejects stale cancel and submit requests after a new attempt replaces the old one",async()=>{
 const f=await controllerFixture();const first=await f.controller.startLogin(f.paseo,f.account.id);
 await f.controller.cancelLogin(f.paseo,f.account.id,first.id);
 const second=await f.controller.startLogin(f.paseo,f.account.id);
 await expect(f.controller.cancelLogin(f.paseo,f.account.id,first.id)).rejects.toThrow(/no longer active/);
 await expect(f.controller.submitLoginCode(f.account.id,first.id,"fixture#fixture")).rejects.toThrow(/no longer active/);
 f.fake.calls[0].onExit(0,true);
 await vi.waitFor(async()=>expect((await f.controller.store.read()).accounts.find(a=>a.id===f.account.id)?.loginToken).toBe(second.id));
});

it("waits for an older identity probe after reserving the account and before launching native login",async()=>{
 const f=await controllerFixture();
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 boundaries.probe.mockImplementationOnce(async()=>{entered();await gate;return{identityKey:"old-identity",email:"old@example.test",plan:"plus",authStatus:"ready"};});
 const check=f.controller.checkAccount(f.account.id);await started;
 const login=f.controller.startLogin(f.paseo,f.account.id);
 try{
  await vi.waitFor(async()=>expect((await f.controller.store.read()).accounts.find(a=>a.id===f.account.id)?.loginToken).toBeTruthy());
  expect(f.fake.start).not.toHaveBeenCalled();
 }finally{release();await check;await login;}
 expect(f.fake.start).toHaveBeenCalledTimes(1);
 expect((await f.controller.store.read()).accounts.find(a=>a.id===f.account.id)?.identityKey).not.toBe("old-identity");
});

it("recovers an interrupted background reservation only after its matching watchdog receipt",async()=>{
 const f=await controllerFixture();
 await f.controller.store.change(state=>{const account=state.accounts.find(a=>a.id===f.account.id)!;account.loginToken="interrupted-session";account.login={sessionId:"interrupted-session",mode:"device"};});
 expect(await f.controller.getLoginStatus(f.account.id,"interrupted-session")).toMatchObject({status:"error",authorizationUrl:null,userCode:null});
 await expect(f.controller.cancelLogin(f.paseo,f.account.id,"interrupted-session")).rejects.toThrow(/still stopping/);
 expect((await f.controller.store.read()).accounts.find(a=>a.id===f.account.id)?.loginToken).toBe("interrupted-session");
 await mkdir(join(f.root,"logins"),{recursive:true});
 await writeFile(join(f.root,"logins",f.account.id+".json"),JSON.stringify({loginToken:"interrupted-session",exitCode:1,finishedAt:new Date().toISOString()}));
 await f.controller.cancelLogin(f.paseo,f.account.id,"interrupted-session");
 expect((await f.controller.store.read()).accounts.find(a=>a.id===f.account.id)).toMatchObject({loginToken:null,login:null});
});
