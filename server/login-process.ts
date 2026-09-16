import { spawn } from "node:child_process";

export type LoginProcessOptions = {
  command: string[]; args: string[]; env: NodeJS.ProcessEnv; cwd: string;
  receiptPath: string; loginToken: string;
  onData: (stream: "stdout" | "stderr", data: string) => void;
  onExit: (code: number, receiptWritten: boolean) => void;
};
export type LoginProcess = { ready(): Promise<void>; start(): void; write(data: string): void; stop(code?: number): Promise<void> };
export type CreateLoginProcess = (options: LoginProcessOptions) => LoginProcess;

// The IPC pipe is an OS-owned parent-liveness signal. Even an abrupt daemon exit
// closes it, so this supervisor can stop the native process before recording exit.
// No authentication output, URLs, or codes are written to the receipt.
const supervisor = String.raw`
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
let child,config={receiptPath:process.argv[1],loginToken:process.argv[2]},launched=false,finished=false,stopping=false,forcedCode,killTimer,deadline;
function kill(signal){if(!child?.pid)return;try{if(process.platform==='win32')child.kill(signal);else process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}}
let finalizing=false;
function finish(code){
 if(finished||finalizing)return;finalizing=true;clearTimeout(killTimer);
 // A leader can exit while a descendant ignores TERM. Kill and observe the
 // entire isolated group before claiming that credential writes have stopped.
 try{kill('SIGKILL');}catch{}
 const until=Date.now()+3000;
 function confirm(){
  let alive=false;if(process.platform!=='win32'&&child?.pid)try{process.kill(-child.pid,0);alive=true;}catch(error){if(error.code!=='ESRCH')alive=true;}
  if(alive){if(Date.now()>=until)return process.exit(1);return setTimeout(confirm,20);}
  record(code);
 }
 confirm();
}
function record(code){
 if(finished)return;finished=true;clearTimeout(deadline);
 let receiptWritten=false;
 if(config)try{const target=config.receiptPath;fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});const temporary=target+'.'+process.pid+'.tmp';fs.writeFileSync(temporary,JSON.stringify({loginToken:config.loginToken,exitCode:forcedCode??code,finishedAt:new Date().toISOString()}),{mode:0o600});fs.renameSync(temporary,target);receiptWritten=true;}catch{}
 if(process.connected)process.send({type:'exit',code:forcedCode??code,receiptWritten},()=>process.exit(0));else process.exit(0);
}
function stop(code=1){
 if(stopping||finished)return;stopping=true;forcedCode=code;
 if(!child)return finish(1);
 try{kill('SIGTERM');}catch{}
 killTimer=setTimeout(()=>{try{kill('SIGKILL');}catch{}},500);
 // Do not claim exit or write a receipt without observing the native close event.
 deadline=setTimeout(()=>process.exit(1),4000);
}
process.on('disconnect',()=>stop(1));process.on('SIGTERM',()=>stop(1));process.on('SIGINT',()=>stop(1));
process.on('message',message=>{
 if(message?.type==='stop')return stop(message.code===0?0:1);
 if(message?.type!=='start'||launched||stopping)return;
 launched=true;config={...config,...message};
 try{
  child=spawn(config.command[0],[...config.command.slice(1),...config.args],{env:config.env,cwd:config.cwd,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true});
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);process.stdin.pipe(child.stdin);
  child.stdin.on('error',()=>{});child.once('error',()=>finish(1));child.once('close',code=>finish(code??1));
 }catch{finish(1);}
});
if(!process.connected)stop(1);else process.send({type:'ready'});
`;

export const createLoginProcess: CreateLoginProcess = options => {
  const child = spawn(process.execPath, ["-e", supervisor, options.receiptPath, options.loginToken], {
    cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  let receipt: { code: number; receiptWritten: boolean } | undefined;
  let exited = false;
  let acknowledge!: () => void, rejectReady!: () => void;
  const ready = new Promise<void>((resolve,reject) => { acknowledge=resolve;rejectReady=()=>reject(new Error("Could not start the sign-in watchdog.")); });
  void ready.catch(()=>{});
  const closed = new Promise<void>(resolve => {
    child.once("close", () => {
      exited = true;
      rejectReady();
      options.onExit(receipt?.code ?? 1, receipt?.receiptWritten ?? false);
      resolve();
    });
  });
  child.on("error", rejectReady);
  child.stdin!.on("error", () => {});
  child.stdout!.setEncoding("utf8").on("data", data => options.onData("stdout", data));
  child.stderr!.setEncoding("utf8").on("data", data => options.onData("stderr", data));
  child.on("message", message => {
    if (message && typeof message === "object" && "type" in message && message.type === "ready") acknowledge();
    if (message && typeof message === "object" && "type" in message && message.type === "exit") {
      const value = message as Record<string, unknown>;
      receipt = { code: value.code === 0 ? 0 : 1, receiptWritten: value.receiptWritten === true };
    }
  });
  let spawned = false, requested = false;
  const start = () => { if (spawned && requested && child.connected) child.send({ type: "start", command: options.command, args: options.args,
    env: options.env, cwd: options.cwd }, () => {}); };
  child.once("spawn", () => { spawned = true; start(); });
  return {
    async ready() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([ready,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("The sign-in watchdog did not start in time.")),5000);})]); }
      finally { clearTimeout(timer); }
    },
    start() { requested = true; start(); },
    write(data) {
      if (exited || !child.stdin!.writable) throw new Error("The sign-in process is no longer available.");
      child.stdin!.write(data);
    },
    async stop(code = 1) {
      if (!exited) {
        if (child.connected) child.send({ type: "stop", code }, () => {});
        else child.kill("SIGTERM");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Could not confirm that sign-in stopped. Try again shortly.")), 5000);
        })]);
        if (!receipt?.receiptWritten) throw new Error("Could not confirm that sign-in stopped. Try again shortly.");
      } finally { clearTimeout(timer); }
    },
  };
};
