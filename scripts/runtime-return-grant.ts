/** Human operator review for the missing diagnostic return Grant. No Task is sent. */
import {readFileSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {openDatabase,withTransaction} from "../core/db.ts";
import {recordWorld} from "../core/worlds.ts";
import {issueGrant} from "../core/authority.ts";
import {openHumanIngress,explicitHumanStatement,admitHumanAct,type HumanProposal} from "../core/human-admission.ts";
export function returnGrantPlan(db:DatabaseSync,runId:string,reviewingHumanId?:string){
 const row=db.prepare(`SELECT r.session_id,t.origin_node_id,t.center_node_id,t.task_id FROM task_runs r JOIN tasks t USING(task_id) WHERE r.run_id=?`).get(runId);
 if(!row)throw Error("Exact existing diagnostic Run required");
 const world=recordWorld(db,"nodes",String(row.origin_node_id));
 const humans=db.prepare("SELECT human_id FROM world_humans WHERE world_id=? AND (? IS NULL OR human_id=?)").all(world,reviewingHumanId??null,reviewingHumanId??null);
 if(humans.length!==1)throw Error("Exact Human required");
 const humanId=String(humans[0]!.human_id),sourceRef=`human-diagnostic-return-grant:${randomUUID()}`;
 const args={requestId:randomUUID(),subjectNodeId:String(row.center_node_id),capability:"message.send",resourceScope:`node/${row.origin_node_id}`,
  productScope:"codex-app-server",effectScope:"admission" as const,disclosureScope:"handoff_bounded",limit:1,delegable:false,expiresAt:new Date(Date.now()+86400000).toISOString()};
 const proposal:HumanProposal={type:"authority.grant",objectRef:args.subjectNodeId,scope:args.resourceScope,args,targetRevision:null,causalRefs:[sourceRef,`run:${runId}`]};
 return {world,humanId,runId,taskId:String(row.task_id),sessionId:String(row.session_id),sourceRef,proposal,grantInput:args};
}
export function applyReturnGrant(db:DatabaseSync,plan:ReturnType<typeof returnGrantPlan>,confirmation:string){
 if(confirmation!=="ADMIT")throw Error("Human Grant review not confirmed");
 const run=db.prepare("SELECT session_id,task_id FROM task_runs WHERE run_id=?").get(plan.runId);
 if(run?.session_id!==plan.sessionId||run.task_id!==plan.taskId)throw Error("Reviewed Run binding changed");
 return withTransaction(db,"diagnostic_return_grant",()=>{
  const source=openHumanIngress(db,{worldId:plan.world,humanId:plan.humanId,presenceRef:"local-terminal:diagnostic-return",sourceRef:plan.sourceRef});
  const utteranceId=source.capture(plan.sourceRef,explicitHumanStatement(plan.proposal));
  const proof=admitHumanAct(db,{worldId:plan.world,humanId:plan.humanId,utteranceId,proposal:plan.proposal});
  return issueGrant(db,{kind:"human",...proof},plan.grantInput);
 });
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 if(!process.stdin.isTTY)throw Error("Human-only Grant review requires an interactive terminal");
 const root=resolve(import.meta.dirname,".."),data=join(root,".sidera-dev/sol/data"),evidence=join(root,".sidera-dev/runtime-activation/20261003-1105");
 const diagnostic=JSON.parse(readFileSync(join(evidence,"loop-db-current.json"),"utf8"));
 const db=openDatabase(join(data,"sidera.sqlite"));
 try{
  const plan=returnGrantPlan(db,diagnostic.runs[0].run_id);
  console.log("Sidera 诊断：Codex 已完成原任务，但返回 Chief 的 message.send 缺少 M2 有效授权。");
  console.log("本次仅授权：Codex -> 原 Chief，一次结果消息；codex-app-server；24 小时有效；不可转授。");
  console.log(`原 Task: ${plan.taskId}; 原 Run: ${plan.runId}`);
  console.log("这只登记你审阅的 Grant，不重发推理、不手工清 uncertain、不创建 Task 或 Chat。");
  console.log(explicitHumanStatement(plan.proposal));process.stdout.write("核对后输入 ADMIT 并回车；其他输入中止: ");
  const answer=await new Promise<string>(r=>process.stdin.once("data",x=>r(String(x).trim())));process.stdin.pause();
  if(answer!=="ADMIT")console.log("Aborted; no Grant created.");
  else{const grant=applyReturnGrant(db,plan,answer);writeFileSync(join(evidence,"return-grant.json"),JSON.stringify({plan,grant,at:new Date().toISOString()},null,2));console.log("Human Grant applied. Original uncertain Run is preserved until provider evidence reconciliation.");}
 }finally{db.close();}
}
