import { beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../server/usage";
import type { Registry, StoredAccount } from "../server/store";

const boundary=vi.hoisted(()=>({status:vi.fn(),credentials:vi.fn()}));
vi.mock("node:child_process",async original=>({...await original<typeof import("node:child_process")>(),execFile:boundary.status}));
vi.mock("../server/usage/claude",async original=>({...await original<typeof import("../server/usage/claude")>(),readClaudeCredentials:boundary.credentials}));
const {probeAccount}=await import("../server/auth");
const account={id:"system-claude",provider:"claude",source:"system",home:join(homedir(),".claude"),identityKey:"known",generation:1} as StoredAccount;
const registry={available:{claude:true},commands:{claude:["fixture-cli"]},sourceEnvironment:{claude:{}}} as unknown as Registry;

beforeEach(()=>{
  vi.resetAllMocks();
  boundary.status.mockImplementation((_command,_args,_options,callback)=>callback({code:1},JSON.stringify({loggedIn:false,authMethod:"none"}),""));
});

describe("Claude sign-in with inaccessible credentials",()=>{
  it("does not treat the CLI's loggedIn:false as sign-out when Keychain is inaccessible",async()=>{
    boundary.credentials.mockRejectedValue(new UsageError("unavailable","keychain_unavailable"));
    expect(await probeAccount(account,registry)).toMatchObject({authStatus:"error"});
    expect(boundary.credentials).toHaveBeenCalledWith(expect.objectContaining({home:account.home}));
  });
  it("still requires sign-in when credentials are definitely absent",async()=>{
    boundary.credentials.mockRejectedValue(new UsageError("needs_auth","missing_credentials"));
    expect(await probeAccount(account,registry)).toMatchObject({authStatus:"needs_auth"});
  });
  it("classifies inaccessible credentials even if a CLI exits zero with loggedIn:false",async()=>{
    boundary.status.mockImplementation((_command,_args,_options,callback)=>callback(null,JSON.stringify({loggedIn:false,authMethod:"none"}),""));
    boundary.credentials.mockRejectedValue(new UsageError("unavailable","keychain_unavailable"));
    expect(await probeAccount(account,registry)).toMatchObject({authStatus:"error"});
  });
  it("requires the official CLI probe to succeed even when stored tokens are readable",async()=>{
    boundary.credentials.mockResolvedValue({source:"file",raw:"fixture"});
    expect(await probeAccount(account,registry)).toMatchObject({authStatus:"needs_auth"});
  });
  it("recovers when the CLI can read its sign-in again",async()=>{
    boundary.status.mockImplementation((_command,_args,_options,callback)=>callback(null,JSON.stringify({loggedIn:true,authMethod:"claude.ai",email:"user@example.test",subscriptionType:"max"}),""));
    expect(await probeAccount(account,registry)).toMatchObject({authStatus:"ready",email:"user@example.test",plan:"max"});
    expect(boundary.credentials).not.toHaveBeenCalled();
  });
});
