const fs = require('node:fs'), io = fs.promises, path = require('node:path'), os = require('node:os'), http = require('node:http');
const shared = process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(),'.cursor');
const config = path.join(shared,'cli-config.json');
const auth = process.platform === 'darwin' ? path.join(os.homedir(),'.cursor','auth.json') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(),'.config'),'cursor','auth.json');
const args = process.argv.slice(2);
async function update(fn) {
  const value = await fn(JSON.parse(await io.readFile(config,'utf8')));
  // An unrelated temporary name: the shared config is protected wherever a write is renamed from.
  const tmp = path.join(path.dirname(shared),'fixture-next.json');await io.writeFile(tmp,JSON.stringify(value));await io.rename(tmp,config);
}
(async () => {
  await io.mkdir(shared,{recursive:true});
  if (!fs.existsSync(config)) await io.writeFile(config,'{}');
  const settings=JSON.parse(await io.readFile(config,'utf8'));
  let account='';try {account=await io.readFile(auth,'utf8');} catch(error) {if(error.code!=='ENOENT')throw error;}
  if (args[0] === '--version') return console.log('fixture');
  if (args[0] === 'worker-server') {
    // Like Cursor's workspace worker: serve on AGENT_CLI_SOCKET_PATH, here once.
    const server=http.createServer((request,response)=>{response.end(JSON.stringify({account,socket:path.basename(process.env.AGENT_CLI_SOCKET_PATH)}));server.close();});
    setTimeout(()=>process.exit(),10000).unref();
    return server.listen(process.env.AGENT_CLI_SOCKET_PATH);
  }
  if (args[0] === 'renamed-worker') {
    // A CLI update that renamed the worker socket: its worker must not start where other accounts could share it.
    try { require('node:child_process').spawn(process.execPath,[__filename,'worker-server'],{env:{...process.env,AGENT_CLI_SOCKET_PATH:path.join(os.homedir(),'renamed.sock')},stdio:'ignore'}); return console.log('started'); }
    catch (error) { return console.log(error.message); }
  }
  if (args[0] === 'drift') {
    // Credential calls a CLI update could switch to: other APIs, path forms, and a temporary file renamed into place.
    process.chdir(path.dirname(auth));
    fs.writeFileSync(require('node:url').pathToFileURL(auth),'url');fs.appendFileSync(Buffer.from(auth),'+buffer');fs.appendFileSync('auth.json','+relative');
    await io.writeFile(auth+'.tmp',fs.readFileSync(auth,'utf8')+'+renamed');await io.rename(auth+'.tmp',auth);
    return console.log(fs.readFileSync(auth,'utf8'));
  }
  if (args[0] === 'login') {
    await io.mkdir(path.dirname(auth),{recursive:true});
    await io.writeFile(auth,process.env.CURSOR_TEST_LOGIN || 'managed-account');
    await update(c=>({...c,authInfo:{activeTeamId:Number(process.env.CURSOR_TEST_TEAM || 1)},privacyCache:undefined}));
    return console.log('https://cursor.com/loginDeepControl?uuid=fixture&challenge=fixture');
  }
  if (args[0] === 'status') {
    const value=account?JSON.parse(account):{};
    return console.log(JSON.stringify({status:value.email?'authenticated':'unauthenticated',isAuthenticated:!!value.email,userInfo:{email:value.email,userId:value.id}}));
  }
  if (args[0] === 'team') {
    if(args[1])await update(c=>({...c,authInfo:{activeTeamId:Number(args[1])},privacyCache:{ghostMode:true,privacyMode:Number(args[1]),updatedAt:2},network:{useHttp1ForAgent:true}}));
    return console.log(JSON.stringify(JSON.parse(await io.readFile(config,'utf8'))));
  }
  if (args[0] === 'inspect') {
    const cp=require('node:child_process');
    // A command run with the same Node binary keeps the normal environment.
    const child=JSON.parse(await new Promise(resolve=>{let out='';cp.spawn(process.execPath,['-e',
      'console.log(JSON.stringify({home:process.env.HOME,xdg:process.env.XDG_CONFIG_HOME,options:process.env.NODE_OPTIONS,store:process.env.AGENT_CLI_CREDENTIAL_STORE,profile:process.env.PASEO_CURSOR_AUTH_FILE,account:require("fs").readFileSync(process.argv[1],"utf8")}))',auth]).stdout.on('data',d=>out+=d).on('end',()=>resolve(out));}));
    // Like Cursor's worker client: ask the workspace worker, starting it by spawning this CLI on the first failure.
    const socket=path.join(os.homedir(),'worker.sock');
    const ask=()=>new Promise((resolve,reject)=>http.request({socketPath:socket,path:'/'},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>resolve(JSON.parse(d)));}).on('error',reject).end());
    let worker;for(let i=0;i<50&&!worker;i++)try{worker=await ask();}catch{if(!i)cp.spawn(process.execPath,[__filename,'worker-server'],{env:{...process.env,AGENT_CLI_SOCKET_PATH:socket},stdio:'ignore'});await new Promise(r=>setTimeout(r,100));}
    return console.log(JSON.stringify({team:settings.authInfo?.activeTeamId,privacy:settings.privacyCache?.privacyMode,account,session:await io.readFile(path.join(shared,'session'),'utf8'),child,worker}));
  }
  if (args[0] === 'acp') {
    console.log(JSON.stringify({xdg:process.env.XDG_CONFIG_HOME,shared,args,key:process.env.CURSOR_API_KEY,home:process.env.HOME,account}));
    return process.stdin.pipe(process.stdout);
  }
  process.exitCode=4;
})().catch(()=>{process.exitCode=1;});
