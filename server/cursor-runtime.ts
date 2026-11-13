import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Redirect Cursor's credential and account-specific config file operations inside
// the CLI process. Other settings and ACP sessions remain shared.
export const CURSOR_PRELOAD = String.raw`
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), url=require('node:url'), crypto=require('node:crypto'), cp=require('node:child_process'), http=require('node:http');
const target=process.env.PASEO_CURSOR_AUTH_FILE, marker=process.env.PASEO_CURSOR_PRELOAD_MARKER;
const options=process.env.PASEO_CURSOR_ORIGINAL_NODE_OPTIONS, store=process.env.PASEO_CURSOR_ORIGINAL_STORE;
if(!target)throw Error('Missing Cursor credential profile');
// Cursor's workspace worker reruns this CLI and needs the same profile; other commands keep the normal environment.
const own={};for(const key of ['NODE_OPTIONS','AGENT_CLI_CREDENTIAL_STORE','PASEO_CURSOR_AUTH_FILE','PASEO_CURSOR_ORIGINAL_NODE_OPTIONS','PASEO_CURSOR_ORIGINAL_STORE'])own[key]=process.env[key];
// Each account gets its own worker socket, of the same length as Cursor's. A worker starts only on a socket its client
// was moved from; any other worker is refused rather than shared with another account.
const sockets=new Set(), socket=file=>path.join(path.dirname(file),crypto.createHash('sha256').update(target).digest('hex').slice(0,6)+'.sock');
const request=http.request;http.request=function(opts,...args){if(typeof opts?.socketPath==='string'&&path.basename(opts.socketPath)==='worker.sock'){sockets.add(opts.socketPath);opts={...opts,socketPath:socket(opts.socketPath)};}return request.call(this,opts,...args);};
const spawn=cp.spawn;cp.spawn=function(file,args,opts){if(file===process.execPath&&Array.isArray(args)&&args.includes(process.argv[1])){const env={...(opts?.env??process.env),...own};if(env.AGENT_CLI_SOCKET_PATH){if(!sockets.has(env.AGENT_CLI_SOCKET_PATH))throw Error('Cursor worker isolation was not confirmed');env.AGENT_CLI_SOCKET_PATH=socket(env.AGENT_CLI_SOCKET_PATH);}opts={...opts,env};}return spawn.call(this,file,args,opts);};
for(const key of ['PASEO_CURSOR_AUTH_FILE','PASEO_CURSOR_PRELOAD_MARKER','PASEO_CURSOR_ORIGINAL_NODE_OPTIONS','PASEO_CURSOR_ORIGINAL_STORE'])delete process.env[key];
if(options===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=options;
const auth=process.platform==='darwin'?path.join(os.homedir(),'.cursor','auth.json'):path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'cursor','auth.json');
const config=path.join(process.env.CURSOR_CONFIG_DIR||path.join(os.homedir(),'.cursor'),'cli-config.json'),local=path.join(path.dirname(target),'cli-auth.json');
const io=fs.promises, read=io.readFile.bind(io), write=io.writeFile.bind(io), rename=io.rename.bind(io), unlink=io.unlink.bind(io), fields=['authInfo','privacyCache'];
let sawAuth=false,sawConfig=false,confirmed=false;
function confirm(){
 if(!sawAuth||!sawConfig||confirmed)return;confirmed=true;
 if(store===undefined)delete process.env.AGENT_CLI_CREDENTIAL_STORE;else process.env.AGENT_CLI_CREDENTIAL_STORE=store;
 if(marker)fs.writeFileSync(marker,String(process.pid),{mode:0o600});
}
const where=file=>{try{return path.resolve(file instanceof URL?url.fileURLToPath(file):Buffer.isBuffer(file)?String(file):file);}catch{}};
// Node file calls naming Cursor's credential file, or a temporary file beside it, in any path form use the account's
// file instead. Redirection confirms the launch even if the read then fails: Cursor treats that as signed out.
function redirect(name,args){
 for(let i=0;i<(/^(rename|copyFile)/.test(name)?2:1);i++){const file=where(args[i]);if(file===auth||file?.startsWith(auth+'.')){args[i]=target+file.slice(auth.length);sawAuth=true;}}
 confirm();return args;
}
const calls=['readFile','writeFile','appendFile','open','rename','copyFile','unlink','rm','truncate','chmod'];
for(const name of [...calls,...calls.map(name=>name+'Sync'),'createReadStream','createWriteStream']){const original=fs[name];fs[name]=function(...args){return original.apply(this,redirect(name,args));};}
async function readJSON(file){try{return JSON.parse(await read(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;}}
async function saveLocal(value){
 const state={};for(const field of fields)if(value[field]!==undefined)state[field]=value[field];
 const old=await readJSON(local);if(JSON.stringify(old)===JSON.stringify(state))return;
 const tmp=local+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';
 try{await write(tmp,JSON.stringify(state),{mode:0o600});await rename(tmp,local);}finally{try{await unlink(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
// Whatever lands in the shared config, written directly or renamed into place, keeps the shared copy's account fields.
const object=text=>{try{const value=JSON.parse(String(text));if(value&&typeof value==='object'&&!Array.isArray(value))return value;}catch{}};
async function split(value){
 await saveLocal(value);const shared=await readJSON(config);
 for(const field of fields)if(Object.hasOwn(shared,field))value[field]=shared[field];else delete value[field];
 sawConfig=true;confirm();return JSON.stringify(value,null,2)+'\n';
}
for(const name of [...calls,'mkdir']){
 const original=io[name].bind(io);
 io[name]=async function(...args){
  if((name==='chmod'||name==='mkdir'&&path.dirname(auth)!==path.dirname(config))&&args[0]===path.dirname(auth))args[0]=path.dirname(target);
  else redirect(name,args);
  if(name==='readFile'&&where(args[0])===config){
   const raw=await original(...args), value=JSON.parse(String(raw)), state=await readJSON(local);
   for(const field of fields)if(Object.hasOwn(state,field))value[field]=state[field];else delete value[field];
   sawConfig=true;confirm();const result=JSON.stringify(value);return Buffer.isBuffer(raw)?Buffer.from(result):result;
  }
  if(name==='writeFile'&&where(args[0])===config){const value=object(args[1]);if(value){const data=await split(value);args[1]=Buffer.isBuffer(args[1])?Buffer.from(data):data;}}
  if(name==='rename'&&where(args[1])===config){const value=object(await read(args[0],'utf8').catch(()=>''));if(value)await write(args[0],await split(value));}
  return original(...args);
 };
}
`;

export function cursorEnvironment(home: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const root = dirname(dirname(dirname(home)));
  const preload = join(root, "bin", "cursor-preload.cjs");
  const env: NodeJS.ProcessEnv = {
    // Linux already defaults to the file store; setting it there makes Cursor's wrapper skip system CAs.
    AGENT_CLI_CREDENTIAL_STORE: process.platform === "darwin" ? "file" : undefined,
    PASEO_CURSOR_AUTH_FILE: join(home, "cursor", "auth.json"),
    NODE_OPTIONS: `${base.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim(),
  };
  if (base.NODE_OPTIONS !== undefined) env.PASEO_CURSOR_ORIGINAL_NODE_OPTIONS = base.NODE_OPTIONS;
  if (base.AGENT_CLI_CREDENTIAL_STORE !== undefined) env.PASEO_CURSOR_ORIGINAL_STORE = base.AGENT_CLI_CREDENTIAL_STORE;
  return env;
}

// Check an unknown CLI with disposable homes before allowing it to see real profiles.
export async function verifyCursorCommand(command: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-cursor-check-"));
  const marker = join(directory, "loaded"), profile = join(directory, "profile", "cursor");
  try {
    await mkdir(profile,{recursive:true,mode:0o700});
    const pid = await new Promise<number>((resolve, reject) => {
      const child = execFile(command[0], [...command.slice(1), "--version"], {
        env: { ...env, HOME:directory, XDG_CONFIG_HOME:join(directory,"config"), XDG_CACHE_HOME:join(directory,"cache"), CURSOR_CONFIG_DIR:join(directory,"shared"), PASEO_CURSOR_AUTH_FILE:join(profile,"auth.json"), PASEO_CURSOR_PRELOAD_MARKER:marker }, timeout: 20_000, maxBuffer: 64 * 1024,
      }, error => error || !child.pid ? reject(new Error("Cursor isolation check failed")) : resolve(child.pid));
    });
    if (await readFile(marker, "utf8") !== String(pid)) throw new Error("Cursor isolation check failed");
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function cursorMarker(): Promise<{path:string;cleanup:()=>Promise<void>}> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-cursor-launch-"));
  return {path:join(directory,"loaded"),cleanup:() => rm(directory,{recursive:true,force:true})};
}

export async function waitCursorMarker(path: string, pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { if (await readFile(path,"utf8") === String(pid)) return; } catch { /* Cursor is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Cursor account isolation was not confirmed");
}
