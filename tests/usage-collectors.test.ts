import { describe, expect, it, vi } from "vitest";
import { collectClaudeUsage, claudeKeychainTarget } from "../server/usage/claude";
import { collectCodexUsage } from "../server/usage/codex";
import { readCredentialVersion, type QuotaAccount } from "../server/usage/index";

const account: QuotaAccount = { id: "a", provider: "claude", home: "/isolated/a", command: [], env: {CLAUDE_CONFIG_DIR:"/isolated/a",USER:"alice"}, identityKey: "a", generation: 1 };
describe("isolated quota collectors", () => {
  it("does not send a Claude token replaced after its identity verification",async()=>{
    const dependencies={platform:"linux",readFile:async()=>JSON.stringify({claudeAiOauth:{accessToken:"verified-fixture"}})};
    const credentialVersion=await readCredentialVersion(account,dependencies);
    const fetch=vi.fn(async()=>new Response(JSON.stringify({five_hour:{utilization:99}})));
    await expect(collectClaudeUsage({...account,credentialVersion,identityCredentialVersion:credentialVersion,requireIdentityVerification:true},{...dependencies,readFile:async()=>JSON.stringify({claudeAiOauth:{accessToken:"replacement-fixture"}}),fetch})).rejects.toMatchObject({code:"credentials_changed"});
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the exact keychain item before the exact home file", async () => {
    const readFile = vi.fn(async () => JSON.stringify({claudeAiOauth:{accessToken:"wrong-file-token"}}));
    const readKeychain = vi.fn(async () => JSON.stringify({claudeAiOauth:{accessToken:"fixture-token",subscriptionType:"max"}}));
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("GET");
      expect(init.headers).toMatchObject({Authorization:"Bearer fixture-token","anthropic-beta":"oauth-2025-04-20"});
      return new Response(JSON.stringify({five_hour:{utilization:0}}));
    });
    const result = await collectClaudeUsage(account, {platform:"darwin",readKeychain,readFile,fetch});
    expect(result.plan).toBe("max");
    expect(readFile).not.toHaveBeenCalled();
    expect(readKeychain).toHaveBeenCalledWith(claudeKeychainTarget(account), undefined);
    expect(claudeKeychainTarget({...account,home:"/user/.claude",env:{HOME:"/user",USER:"bad user"}})).toEqual({service:"Claude Code-credentials",account:"claude-code-user"});
  });
  it("does not fall back to file when keychain contains a different credential type", async () => {
    const readFile = vi.fn();
    await expect(collectClaudeUsage(account, {platform:"darwin",readKeychain:async()=>"{}",readFile})).rejects.toMatchObject({status:"needs_auth"});
    expect(readFile).not.toHaveBeenCalled();
  });
  it("preserves Retry-After and never exposes a raw HTTP error body", async () => {
    await expect(collectClaudeUsage(account,{platform:"linux",readFile:async()=>JSON.stringify({claudeAiOauth:{accessToken:"fixture"}}),fetch:async()=>new Response("secret-from-provider",{status:429,headers:{"Retry-After":"600"}})})).rejects.toMatchObject({status:"unavailable",retryAfterMs:600000,message:"The limits service is temporarily unavailable."});
  });
  it("uses only the supplied profile file if its exact Keychain item is absent", async () => {
    const readFile=vi.fn(async()=>JSON.stringify({claudeAiOauth:{accessToken:"fixture"}}));
    await collectClaudeUsage(account,{platform:"darwin",readKeychain:async()=>null,readFile,fetch:async()=>new Response(JSON.stringify({seven_day:null}))});
    expect(readFile).toHaveBeenCalledExactlyOnceWith("/isolated/a/.credentials.json");
  });
  it("uses the exact profile file after Keychain interaction is unavailable, as the native CLI does", async () => {
    const dependencies={platform:"darwin",readKeychain:async()=>{throw new Error("keychain interaction unavailable");},readFile:vi.fn(async()=>JSON.stringify({claudeAiOauth:{accessToken:"fixture-only"}})),fetch:async()=>new Response(JSON.stringify({five_hour:{utilization:2}}))};
    expect((await collectClaudeUsage(account,dependencies)).windows[0]?.usedPercent).toBe(2);
    expect(await readCredentialVersion(account,dependencies)).toMatch(/^present:[a-f0-9]{64}$/);
    expect(dependencies.readFile).toHaveBeenCalledWith("/isolated/a/.credentials.json");
  });
  it("keeps unavailable status when Keychain cannot be read and the profile file is absent", async () => {
    const dependencies={platform:"darwin",readKeychain:async()=>{throw new Error("keychain locked");},readFile:async()=>{throw Object.assign(new Error("missing"),{code:"ENOENT"});}};
    await expect(collectClaudeUsage(account,dependencies)).rejects.toMatchObject({status:"unavailable"});
    expect(await readCredentialVersion(account,dependencies)).toBe("unavailable");
  });
  it.each([[401,"needs_auth"],[403,"unavailable"]] as const)("classifies HTTP %i without returning the provider body", async (status,expected) => {
    await expect(collectClaudeUsage(account,{platform:"linux",readFile:async()=>JSON.stringify({claudeAiOauth:{accessToken:"fixture"}}),fetch:async()=>new Response("SECRET body",{status})})).rejects.toMatchObject({status:expected});
  });
  it("refuses a credential override pointing at another profile", async () => {
    const readKeychain=vi.fn();
    await expect(collectClaudeUsage({...account,env:{...account.env,CLAUDE_SECURESTORAGE_CONFIG_DIR:"/other"}},{platform:"darwin",readKeychain})).rejects.toMatchObject({status:"unavailable",code:"home_mismatch"});
    expect(readKeychain).not.toHaveBeenCalled();
  });
  it("treats an empty secure-storage override as the default home, never as the custom profile", () => {
    expect(()=>claudeKeychainTarget({...account,env:{...account.env,HOME:"/user",CLAUDE_SECURESTORAGE_CONFIG_DIR:""}})).toThrow();
  });
  it("returns only a credential hash and distinguishes absent credentials from inaccessible storage", async () => {
    const readFile=vi.fn(async()=>"fixture-secret");
    const version=await readCredentialVersion({...account,provider:"codex"},{readFile});
    expect(readFile).toHaveBeenCalledExactlyOnceWith("/isolated/a/auth.json");
    expect(version).toMatch(/^present:[a-f0-9]{64}$/);
    expect(await readCredentialVersion(account,{platform:"linux",readFile:async()=>{throw Object.assign(new Error("SECRET"),{code:"ENOENT"});}})).toBe("absent");
    expect(await readCredentialVersion(account,{platform:"darwin",readKeychain:async()=>{throw new Error("SECRET");}})).toBe("unavailable");
  });
  it("runs only the Codex initialization and account quota protocol with the supplied environment", async () => {
    const script = `const readline=require('node:readline');let initialized=false;const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);let result;if(m.method==='initialize')result={};else if(m.method==='initialized'){initialized=true;return;}else if(m.method==='account/read'&&initialized&&m.params.refreshToken===false)result={account:{type:'chatgpt',planType:'plus'}};else if(m.method==='account/rateLimits/read'&&process.env.ONLY_ACCOUNT==='yes')result={accountId:'a',rateLimits:{primary:{usedPercent:0,windowDurationMins:15,resetsAt:0}}};else process.exit(3);process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`;
    const result = await collectCodexUsage({...account,provider:"codex",home:process.cwd(),command:[process.execPath,"-e",script,"--"],env:{ONLY_ACCOUNT:"yes"}});
    expect(result).toMatchObject({identityKey:"a",plan:"plus",windows:[{usedPercent:0,windowDurationMins:15}]});
  });
  it("rejects a Codex quota response for a different authenticated account", async () => {
    const script=`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;const result=m.method==='account/read'?{account:{type:'chatgpt'}}:m.method==='account/rateLimits/read'?{accountId:'another-account',rateLimits:{primary:{usedPercent:12}}}:{};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`;
    await expect(collectCodexUsage({...account,provider:"codex",home:process.cwd(),command:[process.execPath,"-e",script,"--"],env:{}})).rejects.toMatchObject({status:"needs_auth",code:"identity_changed"});
  });
});
