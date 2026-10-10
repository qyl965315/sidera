import { spawn, type StdioOptions } from "node:child_process";
import { randomUUID,createHash } from "node:crypto";
import {createServer} from "node:net";
import {writeFileSync,readFileSync,mkdirSync,rmSync} from "node:fs";
import { join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.ts";
import { reconcileResourceLoss } from "./reconciliation.ts";

/** The witness owns no Host. Its only action after child exit is durable reconciliation. */
export function launchCore(root:string,entry=fileURLToPath(new URL("./service.ts",import.meta.url)),stdio:StdioOptions="inherit") {
 const ownerId=randomUUID();
 const controlToken=randomUUID(),controlPath=join(root,".sidera-dev","sol","data","core-owner.json");
 const endpoint=process.platform==="win32"?`\\\\.\\pipe\\sidera-core-${createHash("sha256").update(resolve(root).toLowerCase()).digest("hex").slice(0,20)}`:join(root,".sidera-dev","core-owner.sock");
 const childStdio:StdioOptions=Array.isArray(stdio)?(stdio.includes("ipc")?stdio:[...stdio,"ipc"]):[stdio,stdio,stdio,"ipc"];
 const child=spawn(process.execPath,[entry],{cwd:root,
  env:{...process.env,SIDERA_PROJECT_ROOT:root,SIDERA_CORE_OWNER_ID:ownerId},stdio:childStdio,windowsHide:true});
 const controller=createServer(socket=>{let text="";socket.on("data",data=>{text+=data.toString();if(text.length>2048){socket.destroy();return;}if(!text.includes("\n"))return;
  try{const p=JSON.parse(text.trim());if(p.token!==controlToken||p.ownerId!==ownerId||p.command!=="stop")throw Error("Invalid operator lifecycle request");
   if(!child.connected)throw Error("Core IPC not available");
   child.once("message",message=>socket.end(JSON.stringify(message)+"\n"));child.send("sidera:graceful-stop");
  }catch(error){socket.end(JSON.stringify({stop:"blocked",reason:String(error)})+"\n");}
 });socket.on("error",()=>{});});
 controller.on("error",()=>{process.stderr.write("Operator lifecycle endpoint unavailable; no stop/retry attempted\n");});
 controller.listen(endpoint,()=>{mkdirSync(join(root,".sidera-dev","sol","data"),{recursive:true});writeFileSync(controlPath,JSON.stringify({ownerId,pid:child.pid,endpoint,token:controlToken}),{mode:0o600});});
 child.once("exit",(code,signal)=>{
  controller.close();try{const owner=JSON.parse(readFileSync(controlPath,"utf8"));if(owner.ownerId===ownerId)rmSync(controlPath,{force:true});}catch{/* Never remove another owner's control record. */}
  const db=openDatabase(join(root,".sidera-dev","sol","data","sidera.sqlite"));
  try {
   const sessions=db.prepare(`SELECT DISTINCT r.session_id FROM task_runs r JOIN run_execution_owners o USING(run_id)
    WHERE o.owner_id=? AND r.turn_open=1`).all(ownerId) as {session_id:string}[];
   for(const session of sessions)reconcileResourceLoss(db,{eventId:randomUUID(),sessionId:session.session_id,
    source:"core.process_exit",reason:`Core owner exited (${signal ?? code}); Host effects may still exist; no replay`});
   db.prepare("UPDATE execution_owners SET state='exited' WHERE owner_id=?").run(ownerId);
  }finally{db.close();}
 });
 return child;
}
if(process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
 const child=launchCore(resolve(process.env.SIDERA_PROJECT_ROOT ?? process.cwd()));
 child.once("exit",code=>{process.exitCode=code ?? 1;});
 child.once("error",()=>{process.stderr.write("Core did not start; no automatic retry\n");process.exitCode=1;});
 process.once("SIGINT",()=>child.kill("SIGINT"));process.once("SIGTERM",()=>child.kill("SIGTERM"));
}
