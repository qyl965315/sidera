import { randomUUID } from "node:crypto";
import { recordWorld, requireWorld } from "./worlds.ts";
import { consumePackageItem } from "./package-proof.ts";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.ts";
import { SideraError, type GrantRecord } from "./types.ts";
import { consumeHumanAct, canonical as canonicalObject } from "./human-admission.ts";
import { appendHistory } from "./history.ts";
import { rulesAllowAction, currentRules, getRuleVersion, ruleVersionCurrent, assertRuleBoundary } from "./rules.ts";
import { consequenceDenial } from "./consequences.ts";
import { isExecutorRuntimeSession } from "./executors.ts";

export type Principal =
  | { kind: "human"; id: string; actId?: string; packageActId?: string }
  | { kind: "node"; nodeId: string };

export interface GrantInput {
  /** Exact standing authorization from an adopted, Human-approved Rule. */
  ruleVersionId?: string;
  validFrom?: string | null;
  worldId?: string;
  projectRef?: string | null;
  taskRef?: string | null;
  modelScope?: string[] | null;
  maxDelegationDepth?: number | null;
  productScope?: string;
  effectScope?: "admission" | "post_admission_revocable";
  disclosureScope?: string;
  requestId?: string;
  subjectNodeId: string;
  capability: string;
  resourceScope: string;
  expiresAt?: string | null;
  limit?: number | null;
  riskCeiling?: number | null;
  delegable?: boolean;
  parentGrantId?: string;
}

export interface ActionRequest {
  /** Compatibility field; v1 now requires explicit Human-rooted grants for every action. */
  requireExplicitGrant?: boolean;
  product?: string;
  effectScope?: "admission" | "post_admission_revocable";
  subjectNodeId: string;
  sessionId: string;
  capability: string;
  resource: string;
  requestId: string;
  taskId?: string;
  projectRef?: string;
  modelId?: string;
  riskLevel?: number;
}

export interface Permit {
  grantId: string | null;
  reservationId: string | null;
}

function capabilityCovers(granted: string, wanted: string): boolean {
  return granted === "*" || granted === wanted ||
    (granted.endsWith(".*") && wanted.startsWith(granted.slice(0, -1)));
}

function scopeCovers(granted: string, wanted: string): boolean {
  return granted === "*" || granted === wanted ||
    (granted.endsWith("/**") && (wanted===granted.slice(0,-3) || wanted.startsWith(granted.slice(0, -2))));
}

function expiryMs(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Additive sidecars preserve old row shapes and historical Human evidence. */
export function migrateAuthority(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS grant_boundaries (
    grant_id TEXT PRIMARY KEY REFERENCES grants(grant_id), valid_from TEXT,
    world_id TEXT NOT NULL REFERENCES sidera_worlds(world_id), project_ref TEXT, task_ref TEXT,
    model_scope_json TEXT, max_delegation_depth INTEGER CHECK(max_delegation_depth>=0)
  );
  CREATE TABLE IF NOT EXISTS grant_use_context (
    reservation_id TEXT PRIMARY KEY REFERENCES grant_uses(reservation_id), context_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS grant_use_rules (
    reservation_id TEXT NOT NULL REFERENCES grant_uses(reservation_id), rule_version_id TEXT NOT NULL,
    PRIMARY KEY(reservation_id,rule_version_id)
  );`);
  for (const table of ["grant_boundaries", "grant_use_context", "grant_use_rules"])
    for (const op of ["UPDATE", "DELETE"]) db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_${op}
      BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'Authority provenance is immutable'); END;`);
}

export function getGrant(db: DatabaseSync, grantId: string): GrantRecord | null {
  const row = db.prepare("SELECT * FROM grants WHERE grant_id = ?").get(grantId) as
    | Record<string, unknown> | undefined;
  if (!row) return null;
  const boundary = db.prepare("SELECT * FROM grant_boundaries WHERE grant_id=?").get(grantId);
  return {
    grantId: String(row.grant_id),
    subjectNodeId: String(row.subject_node_id),
    capability: String(row.capability),
    resourceScope: String(row.resource_scope),
    issuer: String(row.issuer),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    limit: row.use_limit == null ? null : Number(row.use_limit),
    riskCeiling: row.risk_ceiling == null ? null : Number(row.risk_ceiling),
    delegable: Boolean(row.delegable),
    parentGrantId: row.parent_grant_id == null ? null : String(row.parent_grant_id),
    revokedAt: row.revoked_at == null ? null : String(row.revoked_at),
    validFrom: boundary?.valid_from == null ? null : String(boundary.valid_from),
    worldId: boundary?.world_id == null ? recordWorld(db,"nodes",String(row.subject_node_id)) : String(boundary.world_id),
    projectRef: boundary?.project_ref == null ? null : String(boundary.project_ref),
    taskRef: boundary?.task_ref == null ? null : String(boundary.task_ref),
    modelScope: boundary?.model_scope_json == null ? null : JSON.parse(String(boundary.model_scope_json)),
    maxDelegationDepth: boundary?.max_delegation_depth == null ? null : Number(boundary.max_delegation_depth),
  };
}

export function listGrants(db: DatabaseSync, subjectNodeId: string): GrantRecord[] {
  const rows = db.prepare("SELECT grant_id FROM grants WHERE subject_node_id = ? ORDER BY rowid")
    .all(subjectNodeId) as { grant_id: string }[];
  return rows.map(row => getGrant(db, row.grant_id)!);
}

export function revokeGrant(db: DatabaseSync, actor: Principal, input: {
  requestId: string; grantId: string;
}): GrantRecord {
  return withTransaction(db, "grant_revoke", () => {
    if (!input.requestId) throw new SideraError("conflict", "Request ID is required");
    const issuer = actor.kind === "human" ? `human:${actor.id}` : `node:${actor.nodeId}`;
    const prior = db.prepare("SELECT grant_id FROM grant_revocations WHERE actor = ? AND request_id = ?")
      .get(issuer, input.requestId) as { grant_id: string } | undefined;
    if (prior) {
      if (prior.grant_id !== input.grantId)
        throw new SideraError("conflict", "Request ID was already used for another revocation");
      return getGrant(db, prior.grant_id)!;
    }
    const grant = getGrant(db, input.grantId);
    if (!grant) throw new SideraError("not_found", "Grant was not found");
    if(actor.kind==="human") consumeHumanAct(db,actor,recordWorld(db,"nodes",grant.subjectNodeId),"authority.revoke",input.grantId,grant.resourceScope,input);
    else if(grant.issuer!==`node:${actor.nodeId}` || !grant.parentGrantId)
      throw new SideraError("denied","A Node can revoke only the derived grants it issued");
    const now = new Date().toISOString();
    if (!grant.revokedAt)
      db.prepare("UPDATE grants SET revoked_at = ? WHERE grant_id = ?")
        .run(now, input.grantId);
    db.prepare("INSERT INTO grant_revocations VALUES (?, ?, ?)")
      .run(issuer, input.requestId, input.grantId);
    const affected = db.prepare(`WITH RECURSIVE descendants(grant_id) AS (
      SELECT grant_id FROM grants WHERE grant_id = ?
      UNION
      SELECT g.grant_id FROM grants g JOIN descendants d ON g.parent_grant_id = d.grant_id
    ) SELECT DISTINCT subject_node_id FROM grants
      WHERE grant_id IN (SELECT grant_id FROM descendants)`)
      .all(input.grantId) as { subject_node_id: string }[];
    for (const item of affected)
      db.prepare("INSERT INTO events VALUES (?, ?, 'grant.revoked', ?, ?)")
        .run(randomUUID(), null,
          JSON.stringify({ grantId: input.grantId, targetNodeId: item.subject_node_id,
            subjectNodeId: item.subject_node_id, issuer, requestId: input.requestId }), now);
    appendHistory(db,{kind:"Revoke",source:issuer,nodeRef:grant.subjectNodeId,worldRef:recordWorld(db,"nodes",grant.subjectNodeId),
      payload:{grantId:grant.grantId,requestId:input.requestId,descendantsInvalidated:true}});
    return getGrant(db, input.grantId)!;
  });
}

/** A machine-adopted lower version remains rooted in its real admitted ancestor decision. */
function ruleHumanRoot(db:DatabaseSync,rule:NonNullable<ReturnType<typeof getRuleVersion>>):Record<string,unknown>|undefined {
  const seen=new Set<string>();let current:typeof rule|null=rule,historicalGovernance=false;
  while(current){
    if(seen.has(current.versionId)||!historicalGovernance&&!ruleVersionCurrent(db,current)||historicalGovernance&&current.level!=="World")return undefined;
    seen.add(current.versionId);
    if(current.humanActId)return db.prepare(`SELECT a.* FROM human_semantic_acts a JOIN human_act_applications x USING(act_id)
      WHERE a.act_id=? AND a.act_type='rules.adopt' AND a.object_ref=? AND a.world_id=?`)
      .get(current.humanActId,current.proposalId,current.worldId);
    if(current.level==="World"&&current.governanceVersionId){
      const governor=getRuleVersion(db,current.governanceVersionId);
      if(!governor||governor.level!=="World"||governor.worldId!==current.worldId||governor.scopeRef!==current.scopeRef)return undefined;
      try{assertRuleBoundary(governor.boundary,current.boundary);}catch{return undefined;}
      current=governor;historicalGovernance=true;
    }else current=getRuleVersion(db,current.parentVersionId);
  }
  return undefined;
}
export function issueGrant(db: DatabaseSync, actor: Principal, input: GrantInput): GrantRecord {
  return withTransaction(db, "grant_issue", () => {
    const rule=input.ruleVersionId?getRuleVersion(db,input.ruleVersionId):null;
    let ruleAct:Record<string,unknown>|undefined;
    if(input.ruleVersionId){
      if(!rule||rule.level==="Task"||!ruleVersionCurrent(db,rule)||input.parentGrantId)
        throw new SideraError("denied","Rules authorization requires a current adopted World/Project version");
      const grants=rule.policy.authority;
      if(!Array.isArray(grants)||!grants.some(g=>canonicalObject(g)===canonicalObject({...input,ruleVersionId:undefined,requestId:undefined})))
        throw new SideraError("denied","Grant is not an exact standing authorization in the adopted Rules");
      ruleAct=ruleHumanRoot(db,rule);
      if(!ruleAct||actor.kind!=="node"||actor.nodeId!==input.subjectNodeId)throw new SideraError("denied","A Node may materialize only its own exact Rules authorization");
    }
    if(actor.kind==="node" && !input.parentGrantId && !rule)
      throw new SideraError("denied","A derived Grant requires a parent Grant possessed by the issuing Node");
    if (input.limit != null && (!Number.isInteger(input.limit) || input.limit < 1))
      throw new SideraError("conflict", "Grant limit must be a positive integer");
    if (input.riskCeiling != null && (!Number.isInteger(input.riskCeiling) ||
        input.riskCeiling < 0 || input.riskCeiling > 3))
      throw new SideraError("conflict", "Risk ceiling must be an integer from 0 to 3");
    if (!input.capability || !input.resourceScope)
      throw new SideraError("conflict", "Grant capability and scope are required");
    if (input.expiresAt && !Number.isFinite(Date.parse(input.expiresAt)))
      throw new SideraError("conflict", "Grant expiration is invalid");
    if(input.validFrom && !Number.isFinite(Date.parse(input.validFrom)))throw new SideraError("conflict","Grant start time is invalid");
    if(input.maxDelegationDepth!=null && (!Number.isSafeInteger(input.maxDelegationDepth) || input.maxDelegationDepth<0))throw new SideraError("conflict","Delegation depth must be a nonnegative integer");
    if(input.modelScope!=null && (!Array.isArray(input.modelScope) || !input.modelScope.length || input.modelScope.some(m=>typeof m!=="string" || !m.trim())))throw new SideraError("conflict","Model scope requires explicit nonempty model IDs");
    const parent=actor.kind==="node" && input.parentGrantId ? getGrant(db,input.parentGrantId) : null;
    if(actor.kind==="node" && !rule && (!parent || parent.subjectNodeId!==actor.nodeId || !parent.delegable || !effectiveHumanRoot(db,parent) || !chainActive(db,parent)))
      throw new SideraError("denied","Issuing Node lacks a valid delegable parent Grant");
    const expiresAt = input.expiresAt === undefined ? parent?.expiresAt ?? null : input.expiresAt ? new Date(input.expiresAt).toISOString() : null;
    const validFrom=input.validFrom===undefined ? parent?.validFrom??null : input.validFrom ? new Date(input.validFrom).toISOString() : null;
    const limit=input.limit===undefined ? parent?.limit??null : input.limit;
    const riskCeiling=input.riskCeiling===undefined ? parent?.riskCeiling??null : input.riskCeiling;
    const projectRef=input.projectRef===undefined ? parent?.projectRef??null : input.projectRef;
    const taskRef=input.taskRef===undefined ? parent?.taskRef??null : input.taskRef;
    const modelScope=input.modelScope===undefined ? parent?.modelScope??null : input.modelScope;
    const maxDelegationDepth=input.maxDelegationDepth===undefined && parent?.maxDelegationDepth!=null ? parent.maxDelegationDepth-1 : input.maxDelegationDepth??null;
    const issuer = rule ? `rule:${rule.versionId}` : actor.kind==="human" ? `human:${actor.id}` : `node:${actor.nodeId}`;
    // A standing Rules entry names one authorization. Repeated materialization
    // cannot duplicate its budget by choosing fresh request IDs.
    const grantRequestId=rule?`rule-entry:${rule.versionId}:${(rule.policy.authority as unknown[]).findIndex(g=>canonicalObject(g)===canonicalObject({...input,ruleVersionId:undefined,requestId:undefined}))}`:input.requestId;
    const parentProof=parent ? db.prepare("SELECT * FROM grant_provenance WHERE grant_id=?").get(parent.grantId)! : null;
    const productScope=input.productScope??(parentProof?String(parentProof.product_scope):"unspecified");
    const effectScope=input.effectScope??(parentProof?String(parentProof.effect_scope):"admission");
    const disclosureScope=input.disclosureScope??(parentProof?String(parentProof.disclosure_scope):"UNKNOWN");
    const canonical = JSON.stringify({ subjectNodeId: input.subjectNodeId,
      capability: input.capability, resourceScope: input.resourceScope,
      expiresAt, validFrom,limit,riskCeiling,projectRef,taskRef,modelScope,maxDelegationDepth,worldId:input.worldId??null,
      delegable: input.delegable ?? false,parentGrantId: input.parentGrantId ?? null,
      productScope,effectScope,disclosureScope });
    if (grantRequestId) {
      const prior = db.prepare("SELECT input_json, grant_id FROM grant_requests WHERE issuer = ? AND request_id = ?")
        .get(issuer, grantRequestId) as { input_json: string; grant_id: string } | undefined;
      if (prior) {
        const defaults={validFrom:null,projectRef:null,taskRef:null,modelScope:null,maxDelegationDepth:null,worldId:null};
        if (canonicalObject({...defaults,...JSON.parse(prior.input_json)}) !== canonicalObject({...defaults,...JSON.parse(canonical)}))
          throw new SideraError("conflict", "Request ID was already used for another grant");
        return getGrant(db, prior.grant_id)!;
      }
    }
    if (expiresAt && Date.parse(expiresAt) <= Date.now())
      throw new SideraError("conflict", "Grant expiration must be in the future");
    const owner = db.prepare("SELECT node_id FROM nodes WHERE node_id = ? AND lifecycle = 'active'")
      .get(input.subjectNodeId);
    if (!owner) throw new SideraError("not_found", "Subject node is unavailable");
    const worldId=recordWorld(db,"nodes",input.subjectNodeId);
    if(rule&&(rule.worldId!==worldId||rule.level==="Project"&&projectRef!==rule.scopeRef))throw new SideraError("denied","Rules authorization cannot leave its adopted domain");
    if(input.worldId && input.worldId!==worldId)throw new SideraError("denied","Grant cannot cross its subject World");
    if(taskRef)requireWorld(db,worldId,"tasks",taskRef);
    const rules=[currentRules(db,"World",worldId),projectRef?currentRules(db,"Project",projectRef):null,taskRef?currentRules(db,"Task",taskRef):null].filter(r=>r!==null);
    for(const rule of rules){
      const b=rule.boundary;
      if(!ruleVersionCurrent(db,rule)||b.delegable===false && input.delegable || b.maxDelegationDepth!=null && (maxDelegationDepth==null || maxDelegationDepth>b.maxDelegationDepth) ||
        b.maxBudget!=null && (limit==null || limit>b.maxBudget) || b.operations && !b.operations.some(c=>capabilityCovers(c,input.capability)) ||
        b.resources && !b.resources.some(r=>scopeCovers(r,input.resourceScope)) || b.models && (modelScope==null || modelScope.some(m=>!b.models!.includes("*")&&!b.models!.includes(m))) ||
        b.validFrom && (!validFrom || Date.parse(validFrom)<Date.parse(b.validFrom)) || b.expiresAt && (!expiresAt || Date.parse(expiresAt)>Date.parse(b.expiresAt)))
        throw new SideraError("denied","Grant exceeds applicable Rules boundary");
    }
    if(validFrom && expiresAt && Date.parse(validFrom)>=Date.parse(expiresAt))throw new SideraError("conflict","Grant validity interval is empty");
    // A grant is authorized either by its own exact Human act, or by being one
    // exact reviewed item of an approved Permission Package. Both paths bind a
    // real HumanSemanticAct; neither skips the final effect-time gate.
    let actId:string;
    if(rule)actId=String(ruleAct!.act_id);
    else if(actor.kind==="human") actId=actor.packageActId
      ? consumePackageItem(db,actor,worldId,input)
      : consumeHumanAct(db,actor,worldId,"authority.grant",input.subjectNodeId,input.resourceScope,input);
    else {
      if(parent!.worldId!==worldId)throw new SideraError("denied","Derived Grant cannot cross Worlds");
      assertGrantSubset(parent!,{capability:input.capability,resourceScope:input.resourceScope,expiresAt,validFrom,limit,riskCeiling,
        projectRef,taskRef,modelScope,maxDelegationDepth,delegable:input.delegable??false});
      if(parentProof!.product_scope!=="*" && productScope!==parentProof!.product_scope || effectScope!==parentProof!.effect_scope ||
        parentProof!.disclosure_scope!=="*" && disclosureScope!==parentProof!.disclosure_scope)
        throw new SideraError("denied","Derived product/effect/disclosure boundary exceeds parent");
      actId=String(parentProof!.human_act_id);
    }
    const parentGrantId=parent?.grantId??null;
    if (actor.kind==="human" && input.parentGrantId) {
      throw new SideraError("conflict", "Human grants do not inherit a node grant");
    }

    const grantId = randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO grants
      (grant_id, subject_node_id, capability, resource_scope, issuer, expires_at,
       use_limit, risk_ceiling, delegable, parent_grant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(grantId, input.subjectNodeId, input.capability, input.resourceScope, issuer,
        expiresAt, limit, riskCeiling,
        input.delegable ? 1 : 0, parentGrantId);
    db.prepare("INSERT INTO grant_boundaries VALUES (?,?,?,?,?,?,?)")
      .run(grantId,validFrom,worldId,projectRef,taskRef,modelScope?JSON.stringify(modelScope):null,maxDelegationDepth);
    if (grantRequestId)
      db.prepare("INSERT INTO grant_requests VALUES (?, ?, ?, ?)")
        .run(issuer, grantRequestId, canonical, grantId);
    db.prepare("INSERT INTO grant_provenance VALUES (?,?,?,?,?,?)").run(grantId,worldId,actId,
      productScope,effectScope,disclosureScope);
    db.prepare("INSERT INTO events VALUES (?, ?, 'grant.issued', ?, ?)")
      .run(randomUUID(), null,
        JSON.stringify({ grantId, subjectNodeId: input.subjectNodeId,
          targetNodeId: input.subjectNodeId, parentGrantId,
          capability: input.capability, resourceScope: input.resourceScope,
          issuer, requestId: input.requestId ?? null }), createdAt);
    appendHistory(db,{kind:"Grant",source:issuer,nodeRef:input.subjectNodeId,worldRef:worldId,projectRef:projectRef??undefined,taskRef:taskRef??undefined,
      rulesVersions:Object.fromEntries(rules.map(r=>[r.level,r.versionId])),
      payload:{grantId,parentGrantRef:parentGrantId,issuer,capability:input.capability,resourceScope:input.resourceScope,validFrom,expiresAt,limit,riskCeiling,modelScope,delegable:input.delegable??false,humanActId:actId}});
    return getGrant(db, grantId)!;
  });
}

export function grantChain(db: DatabaseSync, leaf: GrantRecord): GrantRecord[] {
  const chain = [leaf];
  const seen=new Set([leaf.grantId]);
  let current = leaf;
  while (current.parentGrantId) {
    const parent = getGrant(db, current.parentGrantId);
    if (!parent) throw new SideraError("denied", "Grant parent is missing");
    if(seen.has(parent.grantId))throw new SideraError("denied","Grant ancestry cycle");
    seen.add(parent.grantId);
    chain.push(parent);
    current = parent;
  }
  return chain;
}

type GrantSubset=Pick<GrantRecord,"capability"|"resourceScope"|"expiresAt"|"limit"|"riskCeiling"|"delegable"> &
  Pick<GrantRecord,"validFrom"|"projectRef"|"taskRef"|"modelScope"|"maxDelegationDepth">;
export function assertGrantSubset(parent:GrantRecord, child:GrantSubset):void {
  if(!parent.delegable || !capabilityCovers(parent.capability,child.capability) || !scopeCovers(parent.resourceScope,child.resourceScope) ||
    parent.expiresAt!=null && (child.expiresAt==null || Date.parse(child.expiresAt)>Date.parse(parent.expiresAt)) ||
    parent.validFrom!=null && (child.validFrom==null || Date.parse(child.validFrom)<Date.parse(parent.validFrom)) ||
    parent.limit!=null && (child.limit==null || child.limit>parent.limit) ||
    parent.riskCeiling!=null && (child.riskCeiling==null || child.riskCeiling>parent.riskCeiling) ||
    parent.projectRef!=null && parent.projectRef!==child.projectRef || parent.taskRef!=null && parent.taskRef!==child.taskRef ||
    parent.modelScope!=null && (child.modelScope==null || child.modelScope.some(m=>!parent.modelScope!.includes(m))) ||
    parent.maxDelegationDepth!=null && (parent.maxDelegationDepth<1 || child.maxDelegationDepth==null || child.maxDelegationDepth>=parent.maxDelegationDepth))
    throw new SideraError("denied","Derived Grant must narrow every parent boundary");
}

function chainActive(db:DatabaseSync,grant:GrantRecord):boolean {
  const now=Date.now();
  return grantChain(db,grant).every(g=>Boolean(db.prepare("SELECT 1 FROM nodes WHERE node_id=? AND lifecycle='active'").get(g.subjectNodeId)) && !g.revokedAt && (g.validFrom==null || Date.parse(g.validFrom)<=now) &&
    (g.expiresAt==null || Date.parse(g.expiresAt)>now));
}
function chainConstraintsAllow(db:DatabaseSync,grant:GrantRecord,resource:string):boolean {
  return grantChain(db,grant).every(g=>!db.prepare("SELECT resource_scope FROM authority_constraints WHERE subject_node_id=? AND active=1")
    .all(g.subjectNodeId).some(c=>scopeCovers(String(c.resource_scope),resource)));
}

function usedWithin(db: DatabaseSync, ancestorGrantId: string): number {
  const row = db.prepare(`WITH RECURSIVE descendants(grant_id) AS (
      SELECT grant_id FROM grants WHERE grant_id = ?
      UNION
      SELECT g.grant_id FROM grants g JOIN descendants d ON g.parent_grant_id = d.grant_id
    ) SELECT COUNT(*) AS count FROM grant_uses
      WHERE grant_id IN (SELECT grant_id FROM descendants)
        AND status IN ('reserved', 'consumed')`).get(ancestorGrantId) as { count: number };
  return row.count;
}

export function effectiveHumanRoot(db:DatabaseSync,grant:GrantRecord):boolean {
  let chain:GrantRecord[];
  try{chain=grantChain(db,grant);}catch{return false;}
  for(let i=0;i<chain.length-1;i++){
    const child=chain[i]!,parent=chain[i+1]!;
    if(child.issuer!==`node:${parent.subjectNodeId}` || child.worldId!==parent.worldId || !db.prepare("SELECT 1 FROM grant_boundaries WHERE grant_id=?").get(child.grantId))return false;
    try{assertGrantSubset(parent,child);}catch{return false;}
    const c=db.prepare("SELECT * FROM grant_provenance WHERE grant_id=?").get(child.grantId),p=db.prepare("SELECT * FROM grant_provenance WHERE grant_id=?").get(parent.grantId);
    if(!c || !p || c.human_act_id!==p.human_act_id || c.world_id!==p.world_id || p.product_scope!=="*" && c.product_scope!==p.product_scope ||
      p.effect_scope!==c.effect_scope || p.disclosure_scope!=="*" && c.disclosure_scope!==p.disclosure_scope)return false;
  }
  const root=chain.at(-1)!;
  const rule=root.issuer.startsWith("rule:")?getRuleVersion(db,root.issuer.slice(5)):null;
  if(rule&&!ruleVersionCurrent(db,rule))return false;
  const humanId=rule ? ruleHumanRoot(db,rule)?.human_id : root.issuer.startsWith("human:")?root.issuer.slice(6):null;
  return typeof humanId==="string" && Boolean(db.prepare(`SELECT 1 FROM grant_provenance p
    JOIN human_semantic_acts a ON a.act_id=p.human_act_id JOIN human_act_applications x USING(act_id)
    WHERE p.grant_id=? AND p.world_id=? AND a.human_id=? AND a.act_type IN ('authority.grant','authority.grant_package','rules.adopt')`).get(root.grantId,
      recordWorld(db,"nodes",root.subjectNodeId),humanId));
}

/** Read-only effective validity for consumers of an explicitly selected Grant. */
export function grantEffectiveNow(db:DatabaseSync,grant:GrantRecord,resource?:string):boolean {
  try{return effectiveHumanRoot(db,grant)&&chainActive(db,grant)&&(!resource||chainConstraintsAllow(db,grant,resource));}catch{return false;}
}

export function issueRuleGrant(db:DatabaseSync,actorNodeId:string,input:{ruleVersionId:string;grantIndex:number;requestId:string}):GrantRecord {
  const rule=getRuleVersion(db,input.ruleVersionId),grants=rule?.policy.authority;
  if(!Array.isArray(grants)||!Number.isSafeInteger(input.grantIndex)||input.grantIndex<0||!grants[input.grantIndex])throw new SideraError("not_found","Rules authorization entry not found");
  return issueGrant(db,{kind:"node",nodeId:actorNodeId},{...grants[input.grantIndex] as GrantInput,ruleVersionId:input.ruleVersionId,requestId:input.requestId});
}

function actionContext(db:DatabaseSync,action:ActionRequest){
  const bound=db.prepare("SELECT model_id FROM model_bindings WHERE node_id=? AND valid_until IS NULL").get(action.subjectNodeId);
  const modelId=bound ? String(bound.model_id) : null;
  if(action.modelId && action.modelId!==modelId)throw new SideraError("denied","Requested model does not match current ModelBinding");
  const taskRule=action.taskId && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rule_versions'").get()
    ? db.prepare("SELECT project_ref FROM rule_versions WHERE level='Task' AND scope_ref=? ORDER BY sequence DESC LIMIT 1").get(action.taskId) : null;
  const taskContext=action.taskId?db.prepare("SELECT project_ref FROM task_rule_context WHERE task_id=?").get(action.taskId):null;
  const projectRef=taskContext?.project_ref?String(taskContext.project_ref):taskRule?.project_ref ? String(taskRule.project_ref) : action.projectRef??null;
  if(action.projectRef&&projectRef!==action.projectRef)throw new SideraError("denied","Task Project context mismatch");
  if(action.projectRef && taskRule?.project_ref && action.projectRef!==taskRule.project_ref)throw new SideraError("denied","Task Project context mismatch");
  return {taskId:action.taskId??null,projectRef,modelId,product:action.product??null,effectScope:action.effectScope??null};
}
function contextCovered(db:DatabaseSync,grant:GrantRecord,action:ActionRequest):boolean {
  const c=actionContext(db,action);
  return (grant.taskRef==null || grant.taskRef===c.taskId) && (grant.projectRef==null || grant.projectRef===c.projectRef) &&
    (grant.modelScope==null || c.modelId!=null && grant.modelScope.includes(c.modelId));
}
function boundedActionContext(db:DatabaseSync,grant:GrantRecord,action:ActionRequest):string {
  const c=actionContext(db,action);
  // The admission reserve may precede Task construction and the later Effect
  // gate supplies its product/context. Only the Grant's actual restrictions
  // bind here; EffectPermit owns exact effect-time request identity.
  return JSON.stringify({taskId:grant.taskRef?c.taskId:null,projectRef:grant.projectRef?c.projectRef:null,modelId:grant.modelScope?c.modelId:null});
}
function applicableRules(db:DatabaseSync,action:ActionRequest){
  const c=actionContext(db,action);
  return [currentRules(db,"World",recordWorld(db,"nodes",action.subjectNodeId)),c.projectRef?currentRules(db,"Project",c.projectRef):null,
    action.taskId?currentRules(db,"Task",action.taskId):null].filter(r=>r!==null);
}
function ruleBudgetAvailable(db:DatabaseSync,action:ActionRequest):boolean {
  return applicableRules(db,action).every(r=>r.boundary.maxBudget==null || Number(db.prepare(`SELECT count(*) n FROM grant_use_rules b
    JOIN grant_uses u USING(reservation_id) WHERE b.rule_version_id=? AND u.status IN ('reserved','consumed')`).get(r.versionId)!.n)<r.boundary.maxBudget);
}

function matchingGrant(db: DatabaseSync, action: ActionRequest): GrantRecord | undefined {
  if(!ruleBudgetAvailable(db,action))return undefined;
  const rows = db.prepare("SELECT grant_id FROM grants WHERE subject_node_id = ? ORDER BY rowid")
    .all(action.subjectNodeId) as { grant_id: string }[];
  const now = Date.now(), riskLevel = action.riskLevel ?? 3;
  for (const row of rows) {
    const grant = getGrant(db, row.grant_id)!;
    if(!effectiveHumanRoot(db,grant) || !chainActive(db,grant) || !chainConstraintsAllow(db,grant,action.resource) || !contextCovered(db,grant,action))continue;
    const provenance=db.prepare("SELECT * FROM grant_provenance WHERE grant_id=?").get(grant.grantId)!;
    if(action.product && ![action.product,"*"].includes(String(provenance.product_scope)))continue;
    if(action.effectScope && action.effectScope!==provenance.effect_scope)continue;
    if (!capabilityCovers(grant.capability, action.capability) ||
        !scopeCovers(grant.resourceScope, action.resource)) continue;
    if (grantChain(db, grant).some(item => item.revokedAt ||
        (item.riskCeiling != null && riskLevel > item.riskCeiling) ||
        (expiryMs(item.expiresAt) != null && expiryMs(item.expiresAt)! <= now) ||
        (item.limit != null && usedWithin(db, item.grantId) >= item.limit))) continue;
    return grant;
  }
}

/** Read-only discovery uses the same Grant chain/budget rules as reservation. */
function requireActionWorld(db: DatabaseSync, action: ActionRequest): void {
  const worldId = recordWorld(db, "nodes", action.subjectNodeId);
  const targetNodeId = /^node\/([^/]+)/.exec(action.resource)?.[1];
  if (targetNodeId && !targetNodeId.includes("*") && db.prepare("SELECT 1 FROM nodes WHERE node_id=?").get(targetNodeId))
    requireWorld(db, worldId, "nodes", targetNodeId);
  if (action.taskId) requireWorld(db, worldId, "tasks", action.taskId);
  const context=actionContext(db,action);
  const consequence=consequenceDenial(db,action.subjectNodeId,action.resource,action.capability,context.projectRef??undefined);
  if(consequence)throw new SideraError("denied",typeof consequence==="string"?consequence:"Project-defined consequence denies this action");
  if(!rulesAllowAction(db,{worldId,projectRef:context.projectRef,taskId:action.taskId,modelId:context.modelId,capability:action.capability,resource:action.resource}))
    throw new SideraError("denied","Applicable World/Project/Task Rules deny this action");
}

export function canUseCapability(db: DatabaseSync, action: ActionRequest): boolean {
  try { requireActionWorld(db, action); actionContext(db,action); } catch { return false; }
  const constraints=db.prepare("SELECT resource_scope FROM authority_constraints WHERE subject_node_id=? AND active=1").all(action.subjectNodeId) as {resource_scope:string}[];
  if(constraints.some(rule=>scopeCovers(rule.resource_scope,action.resource)))return false;
  const risk = action.riskLevel ?? 3;
  if (!Number.isInteger(risk) || risk < 0 || risk > 3) return false;
  if (!db.prepare("SELECT 1 FROM sessions WHERE session_id=? AND node_id=? AND state='active'")
    .get(action.sessionId, action.subjectNodeId) && !isExecutorRuntimeSession(db,action.subjectNodeId,action.sessionId)) return false;
  try{return Boolean(matchingGrant(db, action));}catch{return false;}
}

export function reserveCapability(db: DatabaseSync, action: ActionRequest): Permit {
  return withTransaction(db, "authority_action", () => {
    requireActionWorld(db, action);
    const constraints=db.prepare("SELECT resource_scope,reason FROM authority_constraints WHERE subject_node_id=? AND active=1").all(action.subjectNodeId) as {resource_scope:string;reason:string}[];
    if (constraints.some(rule=>scopeCovers(rule.resource_scope,action.resource)))
      throw new SideraError("denied","Human constraint denies this production resource");
    const riskLevel = action.riskLevel ?? 3;
    if (!Number.isInteger(riskLevel) || riskLevel < 0 || riskLevel > 3)
      throw new SideraError("conflict", "Action risk level must be an integer from 0 to 3");
    const session = db.prepare("SELECT node_id FROM sessions WHERE session_id = ? AND state = 'active'")
      .get(action.sessionId) as { node_id: string } | undefined;
    if ((!session || session.node_id !== action.subjectNodeId) && !isExecutorRuntimeSession(db,action.subjectNodeId,action.sessionId)) {
      throw new SideraError("denied", "Action session is not active for this node");
    }
    const prior = db.prepare(`SELECT reservation_id, grant_id, session_id, capability, resource, risk_level FROM grant_uses
      WHERE subject_node_id = ? AND request_id = ?`).get(action.subjectNodeId, action.requestId) as
      | { reservation_id: string; grant_id: string; session_id: string;
          capability: string; resource: string; risk_level: number } | undefined;
    if (prior) {
      if (prior.session_id !== action.sessionId || prior.capability !== action.capability ||
          prior.resource !== action.resource || prior.risk_level !== riskLevel) {
        throw new SideraError("conflict", "Request ID was already used for another action");
      }
      const priorGrant = getGrant(db, prior.grant_id);
      const priorContext=db.prepare("SELECT context_json FROM grant_use_context WHERE reservation_id=?").get(prior.reservation_id);
      if(priorGrant && priorContext && priorContext.context_json!==boundedActionContext(db,priorGrant,action))throw new SideraError("conflict","Request ID was already reserved for another bounded action context");
      if (!priorGrant || !effectiveHumanRoot(db,priorGrant) || !chainActive(db,priorGrant) || !chainConstraintsAllow(db,priorGrant,action.resource) || !contextCovered(db,priorGrant,action) || grantChain(db, priorGrant).some(item => item.revokedAt ||
          (expiryMs(item.expiresAt) != null && expiryMs(item.expiresAt)! <= Date.now()) ||
          (item.riskCeiling != null && riskLevel > item.riskCeiling)))
        throw new SideraError("denied", "Reserved grant is no longer active");
      return { grantId: prior.grant_id, reservationId: prior.reservation_id };
    }

    const grant = matchingGrant(db, action);
    if (grant) {
      const reservationId = randomUUID();
      db.prepare(`INSERT INTO grant_uses
        (reservation_id, grant_id, request_id, subject_node_id, session_id,
         capability, resource, risk_level, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`)
        .run(reservationId, grant.grantId, action.requestId, action.subjectNodeId,
          action.sessionId, action.capability, action.resource, riskLevel);
      db.prepare("INSERT INTO grant_use_context VALUES (?,?)").run(reservationId,boundedActionContext(db,grant,action));
      for(const rule of applicableRules(db,action))db.prepare("INSERT INTO grant_use_rules VALUES (?,?)").run(reservationId,rule.versionId);
      const context=actionContext(db,action);
      appendHistory(db,{id:`authority-reservation:${reservationId}`,kind:"Action",source:"interface:authority/reserve",worldRef:recordWorld(db,"nodes",action.subjectNodeId),
        nodeRef:action.subjectNodeId,projectRef:context.projectRef??undefined,taskRef:action.taskId,
        rulesVersions:Object.fromEntries(applicableRules(db,action).map(r=>[r.level,r.versionId])),
        payload:{reservationId,grantId:grant.grantId,capability:action.capability,resource:action.resource,requestId:action.requestId,executingSessionRef:action.sessionId}});
      return { grantId: grant.grantId, reservationId };
    }
    throw new SideraError("denied", "No matching authority grant");
  });
}

export function settleReservation(
  db: DatabaseSync, reservationId: string, result: "consumed" | "released",
): void {
  withTransaction(db, "authority_action", () => {
    const row = db.prepare("SELECT status FROM grant_uses WHERE reservation_id = ?")
      .get(reservationId) as { status: string } | undefined;
    if (!row) throw new SideraError("not_found", "Reservation was not found");
    if (row.status === result) return;
    if (row.status !== "reserved") throw new SideraError("conflict", "Reservation was already settled");
    db.prepare("UPDATE grant_uses SET status = ? WHERE reservation_id = ?")
      .run(result, reservationId);
  });
}

/** Human Rules limit Authority without removing the technical capability. */
export function setAuthorityConstraint(db:DatabaseSync,actor:Principal,input:{constraintId:string;subjectNodeId:string;resourceScope:string;reason:string;active:boolean}) {
 if(actor.kind!=="human")throw new SideraError("denied","Only Human can change this trust constraint");
 return withTransaction(db,"authority_constraint",()=>{
  const prior=db.prepare("SELECT subject_node_id FROM authority_constraints WHERE constraint_id=?").get(input.constraintId);
  if(prior && prior.subject_node_id!==input.subjectNodeId)throw new SideraError("denied","Constraint identity belongs to another Node");
  consumeHumanAct(db,actor,recordWorld(db,"nodes",input.subjectNodeId),"authority.constraint",input.subjectNodeId,input.resourceScope,input);
  db.prepare("INSERT INTO authority_constraints VALUES (?,?,?,?,?,?) ON CONFLICT(constraint_id) DO UPDATE SET resource_scope=excluded.resource_scope,reason=excluded.reason,issuer=excluded.issuer,active=excluded.active")
   .run(input.constraintId,input.subjectNodeId,input.resourceScope,input.reason,`human:${actor.id}`,input.active?1:0);
  db.prepare("INSERT INTO events VALUES (?,NULL,'authority.constraint_changed',?,?)").run(randomUUID(),JSON.stringify({...input,targetNodeId:input.subjectNodeId,issuer:`human:${actor.id}`}),new Date().toISOString());
 });
}
