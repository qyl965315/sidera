/** Sidera P0 local Human review helper. No independent Authority: canonical
 * human-admission + permission-package + issueGrant final gates only.
 * plan/status never grant anything. approve requires Human in a REAL local TTY.
 * This helper does not send a Task, create a Host or claim MCP authentication.
 */
import { join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { openDatabase } from "../core/db.ts";
import { recordWorld } from "../core/worlds.ts";
import { canonical, openHumanIngress, explicitHumanStatement, admitHumanAct } from "../core/human-admission.ts";
import { preparePermissionPackage, packageDigest, packageActArgs, packageStatus,
  applyPermissionPackage, materializePermissionPackage, type PermissionPackageManifest } from "../core/permission-package.ts";
const root=resolve(import.meta.dirname,"..");
const data=join(root,".sidera-dev","sol","data");
const checkpoint="D:\\Sidera-R1-checkpoints\\authorized-p0-deploy-20261012";
const planFile=join(checkpoint,"p0-minimal-permissions-review.json");
const packageId="p0-chief-codex-minimal-20261012";
const chief="ba3cb7ac-b601-4706-920d-d540960c3b4f";
const codex="b5ac706e-d9a9-4238-9e1e-ac6377dc763d";
const project="sidera://project/local";
const cmd=process.argv[2]??"status";
const db=openDatabase(join(data,"sidera.sqlite"));
try {
 const worldId=recordWorld(db,"nodes",chief);
 if(recordWorld(db,"nodes",codex)!==worldId)throw Error("CROSS_WORLD_DENIED");
 const b=db.prepare("SELECT project_ref,chief_node_id,state FROM chief_conversations WHERE chief_node_id=? AND project_ref=? AND state='active'")
  .get(chief,project) as {project_ref:string;chief_node_id:string;state:string}|undefined;
 if(!b)throw Error("CHIEF_BINDING_MISSING");
 const human=db.prepare("SELECT human_id FROM world_humans WHERE world_id=? ORDER BY human_id LIMIT 1").get(worldId) as {human_id:string}|undefined;
 if(!human)throw Error("HUMAN_PRINCIPAL_NOT_REGISTERED");
 const prior=packageStatus(db,worldId,packageId);
 if(cmd==="status"){console.log(JSON.stringify({status:prior,packageId,needsHumanTTY:prior.state!=="ADMITTED"},null,2));}
 else if(cmd==="plan"){
  if(prior.state!=="NOT_ADMITTED")throw Error("P0_PACKAGE_ALREADY_RECORDED; inspect status, do not reapprove");
  const expiresAt=new Date(Date.now()+48*60*60*1000).toISOString();
  const items=[
   {purpose:"Chief may dispatch an approved P0 task only to the existing Codex Operator; the current runtime checks exact target Node, while project scope is NOT encoded in this v1 package Grant",grant:{
    subjectNodeId:chief,capability:"task.dispatch",resourceScope:"node/"+codex,
    expiresAt,limit:10,riskCeiling:3,delegable:false,productScope:"*",effectScope:"admission",disclosureScope:"handoff_bounded"}},
   {purpose:"Codex may send bounded completion/results only to the existing Chief Node",grant:{
    subjectNodeId:codex,capability:"message.send",resourceScope:"node/"+chief,
    expiresAt,limit:20,riskCeiling:3,delegable:false,productScope:"*",effectScope:"admission",disclosureScope:"handoff_bounded"}},
   {purpose:"Codex may perform only its own Node operations during the short P0 trial (self-owned resources only)",grant:{
    subjectNodeId:codex,capability:"self.*",resourceScope:"node/"+codex+"/**",
    expiresAt,limit:100,riskCeiling:3,delegable:false,productScope:"*",effectScope:"admission",disclosureScope:"self_sovereign"}}
  ];
  const manifest=preparePermissionPackage({worldId,packageId,label:"P0 Chief-Codex target-bounded and time-bounded trial",revision:1,items:items as never});
  const payload={worldId,projectRef:project,packageId,manifest,digest:packageDigest(manifest),
   objective:"one real task dispatch and bounded result-return; direct Node grants have World scope in package v1, target Node-specific; not permission to impersonate Human, bypass safety, or change workspaces",
   recordedUtc:new Date().toISOString(),expiresAt};
  mkdirSync(checkpoint,{recursive:true});
  writeFileSync(planFile,JSON.stringify(payload,null,2),{mode:0o600,flag:"w"});
  console.log(JSON.stringify({phase:"PLAN_ONLY",packageId,grants:manifest.items.map(x=>({
   purpose:x.purpose,capability:x.grant.capability,resourceScope:x.grant.resourceScope,uses:x.grant.limit,
   expiresAt:x.grant.expiresAt,delegable:x.grant.delegable,riskCeiling:x.grant.riskCeiling})),
   digest:payload.digest,approvalCommand:"node scripts/p0-human-minimal-grant-review.ts approve"},null,2));
 }
 else if(cmd==="approve"){
  if(!process.stdin.isTTY)throw Error("HUMAN_TTY_REQUIRED. An Agent/Chat may not type ADMIT on the Human's behalf.");
  if(prior.state!=="NOT_ADMITTED")throw Error("PACKAGE_ALREADY_RECORDED; inspect status before retry");
  if(!existsSync(planFile))throw Error("PLAN_MISSING");
  const plan=JSON.parse(readFileSync(planFile,"utf8")) as {worldId:string;packageId:string;projectRef:string;manifest:PermissionPackageManifest;digest:string;expiresAt:string};
  const mf=preparePermissionPackage(plan.manifest);
  if(plan.worldId!==worldId||plan.projectRef!==project||plan.packageId!==packageId||
     mf.packageId!==packageId||mf.items.length!==3||packageDigest(mf)!==plan.digest||
     Date.parse(plan.expiresAt)<Date.now()||Date.parse(plan.expiresAt)>Date.now()+49*60*60*1000)
   throw Error("PLAN_STALE_OR_CHANGED");
  const expected=[
   [chief,"task.dispatch","node/"+codex,10],
   [codex,"message.send","node/"+chief,20],
   [codex,"self.*","node/"+codex+"/**",100]
  ];
  mf.items.forEach((item,i)=>{
   const g=item.grant;const [n,c,r,max]=expected[i]!;
   if(g.subjectNodeId!==n||g.capability!==c||g.resourceScope!==r||g.limit!==max||
      g.delegable!==false||g.expiresAt!==plan.expiresAt||g.riskCeiling!==3||
      g.effectScope!=="admission"||g.productScope!=="*"||
      Object.keys(g).some(k=>!["requestId","subjectNodeId","capability","resourceScope","delegable","productScope","effectScope","disclosureScope","expiresAt","limit","riskCeiling"].includes(k)))
     throw Error("REVIEW_SCOPE_TAMPERED");
  });
  const proposal={type:"authority.grant_package" as const,objectRef:mf.packageId,
   scope:"package/"+mf.packageId,targetRevision:null,
   args:packageActArgs(mf) as unknown as Record<string,unknown>,
   causalRefs:["human:local-operator-terminal","human-approved-p0-boundary"]};
  console.log("\nHUMAN REQUIRED: review these exact three bounded Grants:");
  for(const item of mf.items)console.log(item.grant.subjectNodeId.slice(0,8),item.grant.capability,item.grant.resourceScope,
    "uses="+item.grant.limit,"expires="+item.grant.expiresAt);
  console.log("Package SHA256:",plan.digest);
  console.log("Human statement SHA256:",createHash("sha256").update(explicitHumanStatement(proposal)).digest("hex"));
  process.stdout.write("\nType ADMIT to record these exact Human acts. Anything else aborts: ");
  const answer=String(await new Promise<string>(resolve=>process.stdin.once("data",v=>resolve(String(v))))).trim().toUpperCase();
  if(answer!=="ADMIT"){console.log("ABORTED: no authority created.");}
  else{
   const source=openHumanIngress(db,{worldId,humanId:human.human_id,
    presenceRef:"local-terminal:"+String(process.env.COMPUTERNAME??"host"),
    sourceRef:"human-operator-terminal:"+new Date().toISOString().slice(0,10)});
   const messageId="p0-grant-package:"+mf.packageId+":"+plan.digest.slice(0,20);
   const utteranceId=source.capture(messageId,explicitHumanStatement(proposal));
   const proof=admitHumanAct(db,{worldId,humanId:human.human_id,utteranceId,proposal});
   applyPermissionPackage(db,proof,mf);
   const grants=materializePermissionPackage(db,{worldId,humanId:human.human_id,packageActId:proof.actId});
   console.log(JSON.stringify({status:"HUMAN_ADMITTED_AND_MATERIALIZED",grants:grants.grants.map(g=>({
    capability:g.capability,resourceScope:g.resourceScope,grantId:g.grantId})),expiresAt:plan.expiresAt},null,2));
  }
 }else throw Error("Usage: node scripts/p0-human-minimal-grant-review.ts plan|approve|status");
}finally{db.close();}
