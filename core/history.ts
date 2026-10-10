import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SideraError } from "./types.ts";
import { canonical } from "./human-admission.ts";
import { BASIC_RULES_VERSION } from "./constitution.ts";
import { withTransaction } from "./db.ts";
import { recordWorld, requireWorld } from "./worlds.ts";
import { completedMachineReview, getRuleVersion, ruleVersionCurrent, reviewPolicyFor } from "./rules.ts";

export type HistoryKind = "Claim" | "Action" | "Effect" | "HumanDecision" | "RuleChange" | "Grant" | "Revoke" | "Fork" | "Review" | "Consequence" | "Communication" | "RoleBinding";
export interface StateDelta {
  target: string; baseRevision: string | null; nextValue?: unknown; remove?: true;
  source: string; causalParents: string[]; rulesVersions: Record<string,string>;
  effectiveAt: string; recordedAt: string; resolves?: string[];
}
export interface HistoryInput {
  id?: string; kind: HistoryKind; source: string; worldRef?: string; nodeRef?: string;
  communicatorRef?: string; conversationRef?: string; executorRef?: string; projectRef?: string; taskRef?: string;
  parentRecords?: string[]; rulesVersions?: Record<string,string>; payload: unknown; deltaOmega?: StateDelta[]; timestamp?: string;
}
export interface HistoryRecord extends HistoryInput { id: string; sequence: number; timestamp: string; parentRecords: string[]; rulesVersions: Record<string,string> }
export interface OmegaEntry { target: string; revision: string; state: "CURRENT" | "REMOVED" | "UNRESOLVED"; value?: unknown; candidates: Array<{recordId:string;value?:unknown;removed:boolean}> }
const changeKinds = new Set<HistoryKind>(["Effect","HumanDecision","RuleChange","Grant","Revoke","Fork","Consequence"]);
const kindNames = [...changeKinds,"Claim","Action","Review","Communication","RoleBinding"];
const sqlString = (v:string) => `'${v.replaceAll("'","''")}'`;
const identifier = (v:string) => `"${v.replaceAll('"','""')}"`;
function inferredWorld(db:DatabaseSync,nodeRef?:string,taskRef?:string):string|undefined {
  const row=nodeRef?db.prepare("SELECT world_id FROM world_records WHERE table_name='nodes' AND record_key=json_array(?)").get(nodeRef):undefined;
  const task=taskRef?db.prepare("SELECT world_id FROM world_records WHERE table_name='tasks' AND record_key=json_array(?)").get(taskRef):undefined;
  return row?.world_id!=null?String(row.world_id):task?.world_id!=null?String(task.world_id):undefined;
}
export function assertPublicPayload(value:unknown):void {
  const visit=(v:unknown):void=>{
    if(typeof v==="string" && /(?:\bsk-[A-Za-z0-9_-]{18,}|\bBearer\s+[A-Za-z0-9_.-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(v))
      throw new SideraError("denied","Credential values cannot be placed in public History");
    if(v && typeof v==="object") for(const [k,x] of Object.entries(v)) {
      if(/^(?:api_?key|access_?token|refresh_?token|client_?secret|password|authorization|cookie|coreToken)$/i.test(k) && x!=null)
        throw new SideraError("denied","Credential fields cannot be placed in public History");
      visit(x);
    }
  }; visit(value);
}
export function migrateHistory(db:DatabaseSync):void {
  // SQL compatibility adapters use the same credential boundary as typed appends.
  db.function("sidera_public_history", (value) => { assertPublicPayload(JSON.parse(String(value))); return 1; });
  db.exec(`CREATE TABLE IF NOT EXISTS shared_history (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
    source TEXT NOT NULL, world_ref TEXT, node_ref TEXT, communicator_ref TEXT, conversation_ref TEXT,
    executor_ref TEXT, project_ref TEXT, task_ref TEXT, parents_json TEXT NOT NULL,
    rules_json TEXT NOT NULL, payload_json TEXT NOT NULL, delta_json TEXT, timestamp TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS history_by_world ON shared_history(world_ref,sequence);
    CREATE TRIGGER IF NOT EXISTS shared_history_immutable BEFORE UPDATE ON shared_history BEGIN SELECT RAISE(ABORT,'Shared History is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS shared_history_retained BEFORE DELETE ON shared_history BEGIN SELECT RAISE(ABORT,'Shared History must be retained'); END;
    CREATE TRIGGER IF NOT EXISTS shared_history_public BEFORE INSERT ON shared_history BEGIN
      SELECT sidera_public_history(json_object('source',NEW.source,'payload',json(NEW.payload_json),'delta',json(NEW.delta_json))); END;
    CREATE TABLE IF NOT EXISTS history_adapters(source_table TEXT PRIMARY KEY, installed_at TEXT NOT NULL);
  `);
}
/** Infrastructure-only append interface. Node RPC only exposes typed Claim/Review paths, never arbitrary deltas. */
export function appendHistory(db:DatabaseSync,input:HistoryInput):HistoryRecord {
  if(!kindNames.includes(input.kind)||!input.source?.trim())throw new SideraError("conflict","Typed History source required");
  assertPublicPayload(input);
  if(input.deltaOmega?.length && !changeKinds.has(input.kind))throw new SideraError("denied","Claim/Action/communication cannot change Omega");
  const worldRef=input.worldRef??inferredWorld(db,input.nodeRef,input.taskRef);
  const record={...input,...(worldRef?{worldRef}:{}),id:input.id??randomUUID(),timestamp:input.timestamp??new Date().toISOString(),
    parentRecords:input.parentRecords??[],rulesVersions:{Basic:BASIC_RULES_VERSION,...input.rulesVersions}};
  if(!record.id.trim()||!Number.isFinite(Date.parse(record.timestamp))||record.rulesVersions.Basic!==BASIC_RULES_VERSION||
    !Array.isArray(record.parentRecords)||new Set(record.parentRecords).size!==record.parentRecords.length)
    throw new SideraError("conflict","Invalid History identity, protocol version or causal parents");
  const old=db.prepare("SELECT * FROM shared_history WHERE id=?").get(record.id);
  if(old){const prior=fromRow(old); if(canonical({...prior,sequence:undefined,timestamp:undefined})!==canonical({...record,timestamp:undefined}))throw new SideraError("conflict","History identity reused");return prior;}
  const checkParent=(id:string)=>{
    if(typeof id!=="string")throw new SideraError("conflict","History parent must identify a record");
    const parent=db.prepare("SELECT world_ref FROM shared_history WHERE id=?").get(id);
    if(!parent)throw new SideraError("not_found","History parent not found");
    if(record.worldRef&&parent.world_ref&&record.worldRef!==parent.world_ref)
      throw new SideraError("denied","History causal parents cannot cross World boundaries");
  };
  for(const parent of record.parentRecords)checkParent(parent);
  if(input.deltaOmega?.length){
    const priorRecords=readHistory(db);
    const targets=new Set<string>();
    for(const d of input.deltaOmega){
      if(!d.target?.trim()||!d.source?.trim()||!Array.isArray(d.causalParents)||!d.rulesVersions||
        !Number.isFinite(Date.parse(d.recordedAt))||!Number.isFinite(Date.parse(d.effectiveAt))||
        (d.remove===true)===Object.hasOwn(d,"nextValue")||d.remove!==true&&d.nextValue===undefined||d.rulesVersions.Basic!==BASIC_RULES_VERSION||targets.has(d.target))throw new SideraError("conflict","Invalid attributable delta");
      for(const parent of d.causalParents)checkParent(parent);
      for(const prior of priorRecords)if(prior.deltaOmega?.some(change=>change.target===d.target)){
        const ownerWorld=prior.worldRef??inferredWorld(db,prior.nodeRef,prior.taskRef);
        if(ownerWorld&&record.worldRef!==ownerWorld)throw new SideraError("denied","A state target cannot be mutated from another World");
      }
      targets.add(d.target);
    }
    // Validate against the exact prior log before making the append durable.
    projectHistory([...priorRecords,{...record,sequence:Number(db.prepare("SELECT coalesce(max(sequence),0)+1 n FROM shared_history").get()!.n)}]);
  }
  db.prepare(`INSERT INTO shared_history(id,kind,source,world_ref,node_ref,communicator_ref,conversation_ref,executor_ref,project_ref,task_ref,parents_json,rules_json,payload_json,delta_json,timestamp)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.id,record.kind,record.source,record.worldRef??null,record.nodeRef??null,
    record.communicatorRef??null,record.conversationRef??null,record.executorRef??null,record.projectRef??null,record.taskRef??null,
    canonical(record.parentRecords),canonical(record.rulesVersions),canonical(record.payload),record.deltaOmega?canonical(record.deltaOmega):null,record.timestamp);
  return fromRow(db.prepare("SELECT * FROM shared_history WHERE id=?").get(record.id)!);
}
function fromRow(r:Record<string,unknown>):HistoryRecord {
  return {id:String(r.id),sequence:Number(r.sequence),kind:r.kind as HistoryKind,source:String(r.source),
    ...Object.fromEntries([["worldRef","world_ref"],["nodeRef","node_ref"],["communicatorRef","communicator_ref"],["conversationRef","conversation_ref"],
      ["executorRef","executor_ref"],["projectRef","project_ref"],["taskRef","task_ref"]].filter(([,c])=>r[c]!=null).map(([k,c])=>[k,String(r[c])])),
    parentRecords:JSON.parse(String(r.parents_json)),rulesVersions:JSON.parse(String(r.rules_json)),payload:JSON.parse(String(r.payload_json)),
    ...(r.delta_json?{deltaOmega:JSON.parse(String(r.delta_json))}:{}),timestamp:String(r.timestamp)};
}
export function readHistory(db:DatabaseSync,filter:{worldRef?:string;nodeRef?:string;projectRef?:string;afterSequence?:number;limit?:number}={}):HistoryRecord[] {
  const conditions:string[]=[],args:Array<string|number>=[];
  if(filter.worldRef){conditions.push(`coalesce(world_ref,
    (SELECT world_id FROM world_records WHERE table_name='nodes' AND record_key=json_array(shared_history.node_ref)),
    (SELECT world_id FROM world_records WHERE table_name='tasks' AND record_key=json_array(shared_history.task_ref)))=?`);args.push(filter.worldRef);}
  for(const [column,value] of [["node_ref",filter.nodeRef],["project_ref",filter.projectRef]] as const)
    if(value){conditions.push(`${column}=?`);args.push(value);}
  if(filter.afterSequence!=null){conditions.push("sequence>?");args.push(filter.afterSequence);}
  const query=`SELECT * FROM shared_history${conditions.length?' WHERE '+conditions.join(' AND '):''} ORDER BY sequence${filter.limit?' LIMIT ?':''}`;
  if(filter.limit)args.push(Math.min(1000,filter.limit));return db.prepare(query).all(...args).map(fromRow);
}
/** Deterministic Apply. Conflicts remain target-local and no candidate is exposed as a definite value. */
export function projectHistory(records:HistoryRecord[]):Map<string,OmegaEntry> {
  const state=new Map<string,OmegaEntry>(),seen=new Map<string,Map<string,{base:string|null;signature:string}>>();
  const siblings=new Map<string,Map<string,Array<{id:string;signature:string}>>>();
  const aliases=new Map<string,Map<string,string>>(),ids=new Set<string>();let lastSequence=0;
  for(const r of records){
    if(!Number.isSafeInteger(r.sequence)||r.sequence<=lastSequence||ids.has(r.id))throw new SideraError("conflict","History replay requires unique monotonic canonical order");
    lastSequence=r.sequence;ids.add(r.id);
  }
  for(const r of records){
    for(const d of r.deltaOmega??[]){
    if(!changeKinds.has(r.kind))throw new SideraError("conflict","Invalid historical delta kind");
    const current=state.get(d.target), known=seen.get(d.target)??new Map();seen.set(d.target,known);
    const signature=canonical({removed:d.remove===true,...(d.remove?{}:{value:d.nextValue})});
    const byBase=siblings.get(d.target)??new Map<string,Array<{id:string;signature:string}>>();siblings.set(d.target,byBase);
    const equivalents=aliases.get(d.target)??new Map<string,string>();aliases.set(d.target,equivalents);
    const normalizedBase=d.baseRevision===null?null:(equivalents.get(d.baseRevision)??d.baseRevision);
    const base=normalizedBase??"<initial>", peers=byBase.get(base)??[];
    const candidate={recordId:r.id,...(d.remove?{}:{value:d.nextValue}),removed:d.remove===true};
    if(d.resolves?.length){
      if(current?.state!=="UNRESOLVED"||d.baseRevision!==current.revision||canonical([...d.resolves].sort())!==canonical(current.candidates.map(c=>c.recordId).sort()))
        throw new SideraError("conflict","Resolution must name every current conflicting candidate and revision");
    }else{
      if(d.baseRevision!==null && !known.has(d.baseRevision))throw new SideraError("conflict","Delta base revision is not in target history");
      if(current?.state==="UNRESOLVED"){
        const same=peers.find(p=>p.signature===signature);
        if(same){known.set(r.id,{base:d.baseRevision,signature});equivalents.set(r.id,same.id);continue;}
        const candidates=[...current.candidates,candidate];state.set(d.target,{target:d.target,state:"UNRESOLVED",revision:conflictRevision(candidates),candidates});
        known.set(r.id,{base:d.baseRevision,signature});peers.push({id:r.id,signature});byBase.set(base,peers);continue;
      }
      const same=peers.find(p=>p.signature===signature);
      if(same){known.set(r.id,{base:d.baseRevision,signature});equivalents.set(r.id,same.id);continue;}
      if(peers.length || current && current.revision!==normalizedBase){
        const candidates=[...(current?.candidates??[]),candidate];state.set(d.target,{target:d.target,state:"UNRESOLVED",revision:conflictRevision(candidates),candidates});
        known.set(r.id,{base:d.baseRevision,signature});peers.push({id:r.id,signature});byBase.set(base,peers);continue;
      }
    }
    state.set(d.target,{target:d.target,revision:r.id,state:d.remove?"REMOVED":"CURRENT",...(d.remove?{}:{value:d.nextValue}),candidates:[candidate]});
    known.set(r.id,{base:d.baseRevision,signature});peers.push({id:r.id,signature});byBase.set(base,peers);
  }}return state;
}
function conflictRevision(candidates:OmegaEntry["candidates"]):string {return "conflict:"+createHash("sha256").update(candidates.map(c=>c.recordId).sort().join("\n")).digest("hex");}
export function currentOmega(db:DatabaseSync,worldRef?:string):OmegaEntry[]{
  // Reduction needs the complete causal chain. Compatibility INSERT triggers can
  // run before their old World sidecar trigger; filtering first would drop bases.
  const records=readHistory(db), projected=[...projectHistory(records).values()];
  if(!worldRef)return projected;
  const allowed=new Set<string>();
  for(const r of records){const effectiveWorld=r.worldRef??(r.nodeRef?db.prepare("SELECT world_id FROM world_records WHERE table_name='nodes' AND record_key=json_array(?)").get(r.nodeRef)?.world_id:null)??
    (r.taskRef?db.prepare("SELECT world_id FROM world_records WHERE table_name='tasks' AND record_key=json_array(?)").get(r.taskRef)?.world_id:null);
    if(effectiveWorld===worldRef)for(const d of r.deltaOmega??[])allowed.add(d.target);
  }return projected.filter(e=>allowed.has(e.target));
}
export function definiteValue(entry:OmegaEntry|undefined):unknown {
  if(!entry||entry.state!=="CURRENT")throw new SideraError("unavailable",entry?.state==="UNRESOLVED"?"State target is UNRESOLVED":"State target has no definite value");return entry.value;
}

export interface ConflictResolutionInput {
  requestId:string;target:string;expectedRevision:string;candidateRecordIds:string[];selectedRecordId:string;reviewTaskId:string;
}
/** This object selects an existing candidate; callers cannot submit a replacement value. */
export function conflictResolutionObject(input:Omit<ConflictResolutionInput,"reviewTaskId">) {
  for(const key of ["requestId","target","expectedRevision","selectedRecordId"] as const)
    if(typeof input[key]!=="string"||!input[key].trim())throw new SideraError("conflict",`Conflict resolution ${key} required`);
  if(!Array.isArray(input.candidateRecordIds)||input.candidateRecordIds.length<2||input.candidateRecordIds.some(id=>typeof id!=="string"||!id.trim())||
    new Set(input.candidateRecordIds).size!==input.candidateRecordIds.length||!input.candidateRecordIds.includes(input.selectedRecordId))
    throw new SideraError("conflict","Resolution must select one of its exact distinct candidate records");
  const object={requestId:input.requestId,target:input.target,expectedRevision:input.expectedRevision,
    candidateRecordIds:[...input.candidateRecordIds].sort(),selectedRecordId:input.selectedRecordId};
  return {object,objectHash:createHash("sha256").update(canonical(object)).digest("hex")};
}
export function conflictResolutionMarker(input:Omit<ConflictResolutionInput,"reviewTaskId">):string {
  return `SIDERA_CONFLICT_RESOLUTION_V1\n${canonical(conflictResolutionObject(input))}`;
}
function validateRuleResolution(db:DatabaseSync,worldRef:string,target:string,candidate:OmegaEntry["candidates"][number]):void {
  if(!target.startsWith("rules/"))return;
  if(candidate.removed||!candidate.value||typeof candidate.value!=="object")throw new SideraError("denied","Machine resolution cannot remove Rules or create an unadopted policy");
  const value=candidate.value as Record<string,unknown>,id=typeof value.versionId==="string"?value.versionId:"";
  const rule=getRuleVersion(db,id);
  const row=db.prepare("SELECT * FROM rule_versions WHERE version_id=?").get(id);
  if(!rule||!row||rule.worldId!==worldRef||target!==`rules/${worldRef}/${rule.level}/${rule.scopeRef}`||
    db.prepare("SELECT version_id FROM rule_versions WHERE world_id=? AND level=? AND scope_ref=? ORDER BY sequence DESC LIMIT 1").get(worldRef,rule.level,rule.scopeRef)?.version_id!==id||
    canonical(value)!==canonical({versionId:id,level:rule.level,scopeRef:rule.scopeRef,parentVersionId:rule.parentVersionId,boundary:rule.boundary,policy:rule.policy,...(rule.governanceVersionId?{governanceVersionId:rule.governanceVersionId}:{})}))
    throw new SideraError("denied","Resolution requires the latest exact already-adopted Rules version; no Machine policy replacement");
  if(rule.level!=="World"){
    const parent=getRuleVersion(db,rule.parentVersionId);
    if(!parent||parent.worldId!==worldRef||parent.level!==(rule.level==="Project"?"World":"Project")||!ruleVersionCurrent(db,parent))
      throw new SideraError("denied","Resolved Rules must retain the current adopted parent");
  }else if(rule.parentVersionId!==BASIC_RULES_VERSION)throw new SideraError("denied","World Rules must retain Basic protocol");
  // Revalidate the policy that governed adoption, never this Rule's policy for its children.
  const reviewPolicy=reviewPolicyFor(db,rule.level,rule.parentVersionId,rule.governanceVersionId).policy;
  if(reviewPolicy.humanInvolvement==="required"||rule.humanActId){
    const act=db.prepare(`SELECT a.*,p.mutation_type,p.mutation_json FROM human_semantic_acts a
      JOIN human_act_applications p USING(act_id) WHERE a.act_id=? AND a.world_id=?`).get(rule.humanActId??"",worldRef);
    let args:Record<string,unknown>;try{args=JSON.parse(String(act?.args_json));}catch{throw new SideraError("denied","Applied Human adoption object is missing");}
    const refs=args.reviewTaskIds??(args.reviewTaskId?[args.reviewTaskId]:[]);
    const stored=typeof row.review_task_id==="string"&&row.review_task_id.startsWith("[")?JSON.parse(row.review_task_id):row.review_task_id?[row.review_task_id]:[];
    if(args.proposalId!==rule.proposalId||Object.keys(args).some(k=>!["proposalId","reviewTaskId","reviewTaskIds"].includes(k))||
      args.reviewTaskId!==undefined&&args.reviewTaskIds!==undefined||canonical(refs)!==canonical(stored))
      throw new SideraError("denied","Resolution requires the exact existing applied adoption reviews");
    const expected=args;
    if(!act||act.act_type!=="rules.adopt"||act.object_ref!==rule.proposalId||act.scope!==`rules/${rule.level}/${rule.scopeRef}`||
      act.mutation_type!=="rules.adopt"||act.args_json!==canonical(expected)||act.mutation_json!==canonical(expected))
      throw new SideraError("denied","Resolution requires the existing exact applied Human adoption for this policy");
  }
}
/** Authority is reserved by the typed RPC. This helper only closes a reviewed, exact current conflict. */
export function resolveHistoryConflict(db:DatabaseSync,actorNodeRef:string,input:ConflictResolutionInput):HistoryRecord {
  return withTransaction(db,"history_conflict_resolve",()=>{
    const prepared=conflictResolutionObject(input),worldRef=recordWorld(db,"nodes",actorNodeRef);
    if(typeof input.reviewTaskId!=="string"||!input.reviewTaskId.trim())throw new SideraError("conflict","Resolution Review Task required");
    requireWorld(db,worldRef,"tasks",input.reviewTaskId);
    const id=`conflict-resolution:${actorNodeRef}:${input.requestId}`,payload={...prepared.object,reviewTaskId:input.reviewTaskId};
    const old=readHistory(db,{worldRef}).find(r=>r.id===id);
    if(old){if(canonical(old.payload)!==canonical(payload))throw new SideraError("conflict","Conflict resolution request reused");return old;}
    const entry=currentOmega(db,worldRef).find(e=>e.target===input.target);
    if(entry?.state!=="UNRESOLVED"||entry.revision!==input.expectedRevision||
      canonical(entry.candidates.map(c=>c.recordId).sort())!==canonical(prepared.object.candidateRecordIds))
      throw new SideraError("conflict","Resolution must name the exact current UNRESOLVED revision and every candidate");
    if(db.prepare("SELECT 1 FROM history_adapters WHERE source_table=?").get(input.target.split('/')[0]!))
      throw new SideraError("unavailable","Operational state conflict requires its owning adapter's actual-state reconciliation; a Machine selection cannot override the operational index");
    const selected=entry.candidates.find(c=>c.recordId===input.selectedRecordId)!;
    validateRuleResolution(db,worldRef,input.target,selected);
    const task=db.prepare("SELECT * FROM tasks WHERE task_id=? AND origin_node_id=?").get(input.reviewTaskId,actorNodeRef);
    if(!task)throw new SideraError("denied","Resolution Review Task must originate from its requesting actor");
    const review=completedMachineReview(db,{taskId:input.reviewTaskId,reviewerNodeId:String(task.center_node_id),expectedObjectHash:prepared.objectHash});
    const initial=db.prepare("SELECT m.body FROM task_runs r JOIN messages m ON m.message_id=r.message_id WHERE r.run_id=?").get(review.runId);
    if(initial?.body!==conflictResolutionMarker(input))throw new SideraError("denied","Resolution Review Task lacks the exact structured conflict marker");
    const rules={Basic:BASIC_RULES_VERSION,...Object.fromEntries(Object.entries(db.prepare("SELECT world_version_id,project_version_id,task_version_id FROM task_rule_context WHERE task_id=?").get(input.reviewTaskId)??{})
      .filter(([,v])=>v!=null).map(([k,v])=>[k==="world_version_id"?"World":k==="project_version_id"?"Project":"Task",String(v)]))};
    const at=new Date().toISOString(),parents=[...prepared.object.candidateRecordIds];
    if(db.prepare("SELECT 1 FROM shared_history WHERE id=?").get(`message:${review.resultMessageId}`))parents.push(`message:${review.resultMessageId}`);
    return appendHistory(db,{id,kind:"Effect",source:"interface:conflict-resolution",worldRef,nodeRef:actorNodeRef,taskRef:input.reviewTaskId,
      parentRecords:parents,rulesVersions:rules,payload,deltaOmega:[{target:input.target,baseRevision:entry.revision,
        ...(selected.removed?{remove:true as const}:{nextValue:selected.value}),resolves:prepared.object.candidateRecordIds,
        source:`review-result:${review.resultMessageId}`,causalParents:parents,rulesVersions:rules,effectiveAt:at,recordedAt:at}]});
  });
}

/** Compatibility adapters turn real durable operational changes into attributed Effects.
 * Only explicit public columns are captured. Credentials, D/E and raw runtime output are excluded.
 * Tables remain operational compatibility indexes; canonical Omega always reduces this history. */
export function installHistoryAdapters(db:DatabaseSync):void {
  const specs:Array<{table:string;key:string;columns:string[];actor?:string;task?:string;project?:string;kind?:HistoryKind}>=[
    {table:"nodes",key:"node_id",actor:"node_id",columns:["node_id","display_name","lifecycle","created_at"]},
    {table:"tasks",key:"task_id",actor:"center_node_id",task:"task_id",columns:["task_id","origin_node_id","center_node_id","worker_node_ids","state","created_at"]},
    {table:"task_runs",key:"run_id",task:"task_id",columns:["run_id","task_id","session_id","state","turn_open","message_id"]},
    {table:"model_bindings",key:"binding_id",actor:"node_id",columns:["binding_id","node_id","provider","model_id","valid_from","valid_until","migration_from"]},
    {table:"grants",key:"grant_id",actor:"subject_node_id",kind:"Grant",columns:["grant_id","subject_node_id","capability","resource_scope","issuer","parent_grant_id","delegable","expires_at","revoked_at","use_limit"]},
    {table:"responsibilities",key:"responsibility_id",actor:"owner_node_id",columns:["responsibility_id","owner_node_id","state","accepted_at","deferred_at","created_at"]},
    {table:"chief_conversations",key:"binding_id",actor:"chief_node_id",columns:["binding_id","world_id","project_id","chief_node_id","conversation_ref","state"]},
    {table:"node_ontology",key:"node_ref",actor:"node_ref",columns:["node_ref","kind","operator_kind"]},
    {table:"operator_executors",key:"executor_ref",actor:"operator_node_ref",columns:["executor_ref","operator_node_ref","session_id","context_state","reason","routing_admitted"]},
    {table:"task_executor_assignments",key:"assignment_id",task:"task_ref",columns:["assignment_id","task_ref","executor_ref","state","review_ref"]},
    {table:"project_chief_roles",key:"binding_id",actor:"communicator_node_ref",project:"project_ref",columns:["binding_id","project_space_id","project_ref","communicator_node_ref","conversation_ref","state"]},
    {table:"grant_boundaries",key:"grant_id",project:"project_ref",task:"task_ref",columns:["grant_id","valid_from","world_id","project_ref","task_ref","model_scope_json","max_delegation_depth"]},
    {table:"task_rule_context",key:"task_id",task:"task_id",project:"project_ref",columns:["task_id","project_ref","world_version_id","project_version_id","task_version_id"]},
  ];
  for(const s of specs){
    const cols=db.prepare(`PRAGMA table_info(${identifier(s.table)})`).all().map(c=>String(c.name));if(!cols.includes(s.key))continue;
    const selected=s.columns.filter(c=>cols.includes(c));
    const exists=db.prepare("SELECT 1 FROM history_adapters WHERE source_table=?").get(s.table);
    if(!exists){
      for(const row of db.prepare(`SELECT ${selected.map(identifier).join(',')} FROM ${identifier(s.table)} ORDER BY ${identifier(s.key)}`).all()){
        const id=String(row[s.key]),at=new Date().toISOString(),source=`migration:legacy/${s.table}/${id}`;
        const world=row.world_id??db.prepare("SELECT world_id FROM world_records WHERE table_name=? AND record_key=json_array(?)").get(s.table,id)?.world_id??
          inferredWorld(db,s.actor?String(row[s.actor]):undefined,s.task&&row[s.task]!=null?String(row[s.task]):undefined);
        appendHistory(db,{kind:s.kind??"Effect",source,...(world?{worldRef:String(world)}:{}),...(s.actor&&row[s.actor]!=null?{nodeRef:String(row[s.actor])}:{}),...(s.task&&row[s.task]!=null?{taskRef:String(row[s.task])}:{}),
          ...(s.project&&row[s.project]!=null?{projectRef:String(row[s.project])}:{}),
          payload:{compatibilityImport:true,originalActTime:"UNKNOWN",sourceTable:s.table,key:id},deltaOmega:[{target:`${s.table}/${id}`,baseRevision:null,nextValue:row,source,causalParents:[],rulesVersions:{Basic:BASIC_RULES_VERSION},effectiveAt:at,recordedAt:at}]});
      }
      db.prepare("INSERT INTO history_adapters VALUES (?,?)").run(s.table,new Date().toISOString());
    }
    const value=`json_object(${selected.flatMap(c=>[sqlString(c),`NEW.${identifier(c)}`]).join(',')})`;
    const target=`${sqlString(s.table+'/')}||NEW.${identifier(s.key)}`;
    const world=`coalesce(${cols.includes("world_id")?"NEW.world_id":"NULL"},
      (SELECT world_id FROM world_records WHERE table_name=${sqlString(s.table)} AND record_key=json_array(NEW.${identifier(s.key)})),
      ${s.actor?`(SELECT world_id FROM world_records WHERE table_name='nodes' AND record_key=json_array(NEW.${identifier(s.actor)}))`:"NULL"},
      ${s.task?`(SELECT world_id FROM world_records WHERE table_name='tasks' AND record_key=json_array(NEW.${identifier(s.task)}))`:"NULL"})`;
    const base=`(SELECT id FROM shared_history WHERE json_extract(delta_json,'$[0].target')=${target} ORDER BY sequence DESC LIMIT 1)`;
    const at="strftime('%Y-%m-%dT%H:%M:%fZ','now')",source=sqlString(`interface:core/${s.table}`);
    const taskRef=s.task?`NEW.${identifier(s.task)}`:s.table==="tasks"?`NEW.${identifier(s.key)}`:"NULL";
    const rules=`json_patch(json_object('Basic',${sqlString(BASIC_RULES_VERSION)}),coalesce(
      (SELECT json_object('World',world_version_id,'Project',project_version_id,'Task',task_version_id)
       FROM task_rule_context WHERE task_id=${taskRef}),json_object('context','legacy-or-unbound')))`;
    for(const operation of ["INSERT","UPDATE","DELETE"]){
      const deleted=operation==="DELETE",prefix=deleted?"OLD":"NEW";
      const use=(sql:string)=>deleted?sql.replaceAll("NEW.","OLD."):sql;
      const changed=operation==="UPDATE"?` WHEN ${selected.map(c=>`NEW.${identifier(c)} IS NOT OLD.${identifier(c)}`).join(' OR ')}`:"";
      // Definition upgrades affect future acts only. Existing immutable History is retained.
      db.exec(`DROP TRIGGER IF EXISTS ${identifier(`history_${s.table}_${operation.toLowerCase()}`)}`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${identifier(`history_${s.table}_${operation.toLowerCase()}`)} AFTER ${operation} ON ${identifier(s.table)}${changed} BEGIN
        INSERT INTO shared_history(id,kind,source,world_ref,node_ref,task_ref,project_ref,parents_json,rules_json,payload_json,delta_json,timestamp)
        VALUES(lower(hex(randomblob(16))),${sqlString(s.kind??"Effect")},${source},${deleted?`coalesce(${use(world)},(SELECT world_ref FROM shared_history WHERE id=${use(base)}))`:world},${s.actor?`${prefix}.${identifier(s.actor)}`:'NULL'},${s.task?`${prefix}.${identifier(s.task)}`:'NULL'},${s.project?`${prefix}.${identifier(s.project)}`:`(SELECT project_ref FROM task_rule_context WHERE task_id=${use(taskRef)})`},'[]',${use(rules)},
        json_object('sourceTable',${sqlString(s.table)},'key',${prefix}.${identifier(s.key)},'operation',${sqlString(operation)}),
        json_array(json_object('target',${use(target)},'baseRevision',${use(base)},${deleted?"'remove',json('true')":`'nextValue',json(${value})`},'source',${source},'causalParents',json('[]'),'rulesVersions',json(${use(rules)}),'effectiveAt',${at},'recordedAt',${at})),${at});END;`);
    }
  }
  // Body remains in the original communication log. History preserves semantics/provenance,
  // without duplicating potentially private context or credential-bearing model output.
  db.exec("DROP TRIGGER IF EXISTS history_communication; DROP TRIGGER IF EXISTS history_human_communication");
  db.exec(`CREATE TRIGGER IF NOT EXISTS history_communication AFTER INSERT ON messages BEGIN
    INSERT INTO shared_history(id,kind,source,world_ref,node_ref,task_ref,parents_json,rules_json,payload_json,timestamp)
    VALUES('message:'||NEW.message_id,'Communication','interface:message-bus',
    (SELECT world_id FROM world_records WHERE table_name='nodes' AND record_key=json_array(NEW.from_node_id)),NEW.from_node_id,NEW.task_id,'[]',json_object('Basic',${sqlString(BASIC_RULES_VERSION)}),
    json_object('messageRef',NEW.message_id,'fromNodeRef',NEW.from_node_id,'toNodeRef',NEW.to_node_id,'executorRef',NEW.target_session_id,'messageKind',NEW.kind,
    'form',CASE WHEN EXISTS(SELECT 1 FROM node_ontology WHERE node_ref=NEW.from_node_id AND kind='Communicator') AND EXISTS(SELECT 1 FROM node_ontology WHERE node_ref=NEW.to_node_id AND kind='Communicator') THEN 'Discussion'
    WHEN EXISTS(SELECT 1 FROM node_ontology WHERE node_ref IN(NEW.from_node_id,NEW.to_node_id) AND kind='Communicator') THEN 'Thread' ELSE 'Messaging' END),NEW.created_at); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS history_human_communication AFTER INSERT ON human_utterances BEGIN
    INSERT INTO shared_history(id,kind,source,world_ref,communicator_ref,conversation_ref,parents_json,rules_json,payload_json,timestamp)
    SELECT 'human-utterance:'||NEW.utterance_id,'Communication','interface:authenticated-human-ingress',NEW.world_id,
      c.communicator_node_ref,c.conversation_ref,'[]',json_object('Basic',${sqlString(BASIC_RULES_VERSION)}),
      json_object('bodyRef',NEW.utterance_id,'sourceRef',NEW.source_id,'humanRef',s.human_id,
        'externalMessageRef',NEW.external_message_id,'form',CASE WHEN c.conversation_ref IS NOT NULL THEN 'Conversation' ELSE NULL END,
        'surface',CASE WHEN c.conversation_ref IS NOT NULL THEN 'Communicator' ELSE 'Console' END),NEW.recorded_at
    FROM human_frontend_sources s LEFT JOIN communicator_conversations c ON c.conversation_ref=s.source_ref
      AND (SELECT count(*) FROM communicator_conversations a WHERE a.conversation_ref=s.source_ref)=1
      AND EXISTS(SELECT 1 FROM world_records w WHERE w.table_name='nodes' AND w.record_key=json_array(c.communicator_node_ref) AND w.world_id=NEW.world_id)
    WHERE s.source_id=NEW.source_id; END;`);
}
