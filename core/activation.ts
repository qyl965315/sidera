import type { DatabaseSync } from "node:sqlite";
import { canUseCapability } from "./authority.ts";
import type { EffectControlProfile } from "./effect-gate.ts";
import { recordWorld } from "./worlds.ts";
import { latestFrontendPresence } from "./frontend-presence.ts";
import { latestFrontendRoute } from "./frontend-route.ts";
import { isExecutorRuntimeSession } from "./executors.ts";
import {readSessionHostCondition} from "./condition.ts";

/**
 * Fact-derived Runtime Activation.
 *
 * Maintenance is not a flag. It is the projection of a set of durable facts plus
 * live Presence observations. A prerequisite that is satisfied now may become
 * unsatisfied later, and readiness must follow it back down.
 *
 * The operator override is deliberately one-way: it can only BLOCK. There is no
 * environment variable, RPC argument, or Node claim that can turn activation on.
 */

export type Presence = "LIVE" | "LAST_KNOWN" | "UNAVAILABLE";
export type PrerequisiteState = "satisfied" | "unsatisfied" | "unknown";

export const ACTIVATION_PREREQUISITES = [
  "WORLD_APPLICABLE",
  "HUMAN_PRINCIPAL",
  "HUMAN_WORLD_MEMBERSHIP",
  "HUMAN_FRONTEND_BINDING",
  "HUMAN_FRONTEND_PRESENCE",
  "RETURN_ROUTE",
  "RETURN_AUTHORITY",
  "CHIEF_CONVERSATION_IDENTITY",
  "CHIEF_RUNTIME_PRESENCE",
  "TARGET_NODE_IDENTITY",
  "TARGET_PRESENCE",
  "HUMAN_ROOTED_AUTHORITY",
  "EFFECT_CONTROL_PROFILE",
  "EFFECT_GATE_EVALUABLE",
  "GENERATION_FENCING",
  "MIGRATION_MAINTENANCE",
] as const;
export type Prerequisite = typeof ACTIVATION_PREREQUISITES[number];

export interface ActivationInput {
  /** World that the activating subject actually belongs to. */
  worldId: string;
  /** @deprecated Compatibility alias: owning Communicator of the active Chief Conversation. */
  chiefNodeId: string;
  chiefSessionId: string;
  /** Observations taken immediately before evaluation; never cached last-known. */
  live: {
    frontendPresence: Presence;
    chiefRuntimePresence: Presence;
    /** Presence of each candidate target Node, keyed by nodeId. */
    targetPresence?: Record<string, Presence>;
    /** Declared M2 effect control profile per target nodeId. */
    effectProfiles?: Record<string, string | null>;
    /** Declared final-send profile for the Human return route. */
    frontendEffectProfile?: string | null;
    effectIdentityRequired?: Record<string,boolean>;
    frontendIdentityRequired?: boolean;
  };
  /** Capabilities that must be Human-rooted before ordinary dispatch is allowed. */
  required: Array<{ capability: string; resource: string }>;
  /** Operator override. One-way: it can only force maintenance, never clear it. */
  maintenanceForced?: boolean;
}

export interface ActivationDecision {
  ready: boolean;
  mode: "active" | "blocked";
  reasons: string[];
  prerequisites: Record<Prerequisite, PrerequisiteState>;
  detail: Record<string, unknown>;
}

export interface LiveObservation {
  frontendPresence: Presence;
  chiefRuntimePresence: Presence;
  targetPresence?: Record<string, Presence>;
  effectProfiles?: Record<string, string | null>;
  frontendEffectProfile?: string | null;
  effectIdentityRequired?: Record<string,boolean>;
  frontendIdentityRequired?: boolean;
}
export interface ActivationConfig {
  /** How long a live observation may be trusted. Readiness never outlives it. */
  ttlMs?: number;
  base: () => Omit<ActivationInput, "live" | "maintenanceForced">;
  probe: () => Promise<LiveObservation>;
  /** Operator override. One-way blocker; it can never enable activation. */
  maintenanceForced?: boolean;
}
const DEFAULT_TTL_MS = 30_000;

/**
 * What a lapsed observation actually means.
 *
 * The runtime's live-observation cache, the exact-conversation Presence, the
 * prepared route and transport health each have their OWN freshness window and
 * each can expire independently. Reporting one code for all of them is what
 * made "the 30s cache lapsed" look like "the Chat is gone". These are named for
 * the object that is actually stale.
 */
export const OBSERVATION_RECOVERY_ACTION =
  "The Chief Conversation's owning Communicator calls chief_frontend_prepare (explicit, authorized, browser-free). A status query never renews an observation and never opens a transport.";
export type ObservationGap = "RUNTIME_OBSERVATION_NOT_TAKEN" | "RUNTIME_OBSERVATION_STALE" | "RUNTIME_OBSERVATION_FAILED";
export interface FreshnessEntry {
  object: string; source: string | null; evidenceRef: string | null;
  observedAt: string | null; freshUntil: string | null; ageMs: number | null;
  state: string; judgment: string; recoveryAction: string;
}
function freshnessEntry(object: string, state: string, fields: {
  source?: string | null; evidenceRef?: string | null; observedAt?: string | null;
  freshUntil?: string | null; ageMs?: number | null;
}): FreshnessEntry {
  const judgment = state === "LIVE" || state === "USABLE"
    ? "still valid inside its own freshness window; no re-confirmation required"
    : state === "UNKNOWN"
      ? "no observation of this object has ever been recorded"
      : state === "UNVERIFIED"
        ? "no route-verified observation exists for this object; transport evidence is NOT exact-conversation evidence and must not be promoted into it"
        : "past its own freshness window: RE-CONFIRMATION REQUIRED. The object is not assumed invalid, and no evidence has been discarded.";
  return { object, state, source: fields.source ?? null, evidenceRef: fields.evidenceRef ?? null,
    observedAt: fields.observedAt ?? null, freshUntil: fields.freshUntil ?? null, ageMs: fields.ageMs ?? null,
    judgment, recoveryAction: OBSERVATION_RECOVERY_ACTION };
}
/** Which observation is stale, from where, until when, and what renews it. Pure read. */
export function observationFreshness(db: DatabaseSync, input: {
  worldId: string; bindingId: string | null; at?: number;
}): Record<"transportHealth" | "exactPresence" | "preparedRoute", FreshnessEntry> {
  const at = input.at ?? Date.now();
  const empty = (object: string) => freshnessEntry(object, "UNKNOWN", {});
  if (!input.bindingId) return { transportHealth: empty("transport health"),
    exactPresence: empty("exact conversation Presence"), preparedRoute: empty("prepared return route") };
  const poll = db.prepare(`SELECT evidence_class,evidence_ref,method,observed_at,fresh_until
    FROM frontend_presence_observations WHERE world_id=? AND binding_id=? AND evidence_class='TRANSPORT_POLL'
    ORDER BY observed_at DESC LIMIT 1`).get(input.worldId, input.bindingId) as
    { evidence_ref: string; method: string; observed_at: string; fresh_until: string } | undefined;
  const transportHealth = poll
    ? freshnessEntry("transport health", Date.parse(poll.fresh_until) > at ? "LIVE" : "STALE", {
        source: poll.method, evidenceRef: poll.evidence_ref, observedAt: poll.observed_at,
        freshUntil: poll.fresh_until, ageMs: at - Date.parse(poll.observed_at) })
    : empty("transport health");
  // Exact Presence must never be satisfied by transport evidence, and a newer
  // transport poll must never MASK an older still-valid route-verified
  // observation. Only route-verified evidence may answer for exact Presence.
  const presence = db.prepare(`SELECT evidence_class,evidence_ref,method,observed_at,fresh_until
    FROM frontend_presence_observations WHERE world_id=? AND binding_id=? AND evidence_class = 'ROUTE_VERIFIED'
    ORDER BY observed_at DESC LIMIT 1`).get(input.worldId, input.bindingId) as
    { evidence_class: string; evidence_ref: string; method: string; observed_at: string; fresh_until: string } | undefined;
  const exactPresence = presence
    ? freshnessEntry("exact conversation Presence", Date.parse(presence.fresh_until) > at ? "LIVE" : "STALE", {
        source: presence.method, evidenceRef: presence.evidence_ref, observedAt: presence.observed_at,
        freshUntil: presence.fresh_until, ageMs: at - Date.parse(presence.observed_at) })
    : freshnessEntry("exact conversation Presence", "UNVERIFIED", {});
  const route = latestFrontendRoute(db, { worldId: input.worldId, bindingId: input.bindingId, at });
  const preparedRoute = freshnessEntry("prepared return route", route.state, { source: route.method,
    evidenceRef: route.evidenceRef, observedAt: route.preparedAt, freshUntil: route.invalidAfter, ageMs: route.ageMs });
  return { transportHealth, exactPresence, preparedRoute };
}
function activeBindingId(db: DatabaseSync, chiefNodeId: string): string | null {
  const row = db.prepare("SELECT binding_id FROM chief_conversations WHERE chief_node_id=? AND state='active'")
    .get(chiefNodeId) as { binding_id: string } | undefined;
  return row ? String(row.binding_id) : null;
}
function unevaluated(reason: string, detail: Record<string, unknown> = {}): ActivationDecision {
  return {
    ready: false, mode: "blocked", reasons: [reason],
    prerequisites: Object.fromEntries(ACTIVATION_PREREQUISITES.map(n => [n, "unknown"])) as Record<Prerequisite, PrerequisiteState>,
    detail,
  };
}

/**
 * Readiness is derived from durable facts plus a *current* live observation.
 * A cached decision past its TTL is reported as blocked, never as ready, so a
 * lost Presence cannot keep looking healthy.
 */
export class ActivationController {
  private readonly db: DatabaseSync;
  private readonly config: ActivationConfig;
  private cached: { at: number; observation: LiveObservation; decision: ActivationDecision } | null = null;
  private inFlight: Promise<ActivationDecision> | null = null;

  constructor(db: DatabaseSync, config: ActivationConfig) {
    this.db = db; this.config = config;
  }
  async refresh(): Promise<ActivationDecision> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const observation = await this.config.probe();
        const decision = evaluateActivation(this.db, {
          ...this.config.base(), live: observation,
          maintenanceForced: this.config.maintenanceForced,
        });
        this.cached = { at: Date.now(), observation, decision };
        return decision;
      } catch (error) {
        // An observation failure is not evidence of readiness.
        this.cached = null;
        return unevaluated("RUNTIME_OBSERVATION_FAILED", { rawError: String(error),
          failedObject: "runtime live-observation probe", recoveryAction: OBSERVATION_RECOVERY_ACTION });
      } finally { this.inFlight = null; }
    })();
    return this.inFlight;
  }
  /** A status read never refreshes or starts a Host. An expired aggregate cache
   * does not make independently fresh exact Presence and Host evidence stale.
   */
  decision(required?: ActivationInput["required"]): ActivationDecision {
    const base=this.config.base(),bindingId=activeBindingId(this.db,base.chiefNodeId);
    const freshness=observationFreshness(this.db,{worldId:base.worldId,bindingId});
    if(!this.cached)return unevaluated("RUNTIME_OBSERVATION_NOT_TAKEN",{freshness});
    const ttl=this.config.ttlMs??DEFAULT_TTL_MS,age=Date.now()-this.cached.at;
    if(age<=ttl)return evaluateActivation(this.db,{...base,
      required:[...base.required,...(required??[])],
      live:this.cached.observation,maintenanceForced:this.config.maintenanceForced});
    const chief=readSessionHostCondition(this.db,base.chiefSessionId);
    const targetPresence:Record<string,Presence>={};
    const hostConditions:Record<string,{state:string;reason:string;evidenceRef:string|null}>={};
    hostConditions[base.chiefNodeId]={state:chief.state,reason:chief.reason,evidenceRef:chief.evidenceRef};
    for(const nodeId of Object.keys(this.cached.observation.targetPresence??{})){
      const session=this.db.prepare("SELECT session_id FROM sessions WHERE node_id=? AND state='active'").get(nodeId) as
        {session_id:string}|undefined;
      const status=session?readSessionHostCondition(this.db,String(session.session_id)):null;
      targetPresence[nodeId]=status?.canExecute?"LIVE":"UNAVAILABLE";
      hostConditions[nodeId]={state:status?.state??"UNKNOWN",reason:status?.reason??"NO_ACTIVE_SESSION",
        evidenceRef:status?.evidenceRef??null};
    }
    const route=bindingId?latestFrontendRoute(this.db,{worldId:base.worldId,bindingId}):null;
    const routeReady=route?.state==="USABLE"&&route.routeClass!=="ui-fallback" &&
      (route.routeClass!=="protocol"||freshness.transportHealth.state==="LIVE");
    const live:LiveObservation={...this.cached.observation,
      frontendPresence:freshness.exactPresence.state==="LIVE"?"LIVE":"UNAVAILABLE",
      chiefRuntimePresence:chief.canExecute?"LIVE":"UNAVAILABLE",targetPresence,
      frontendEffectProfile:routeReady?route?.controlProfile?.id??null:null};
    const evaluated=evaluateActivation(this.db,{...base,required:[...base.required,...(required??[])],
      live,maintenanceForced:this.config.maintenanceForced});
    const reasons=routeReady?evaluated.reasons:
      [...new Set([...evaluated.reasons,"RETURN_ROUTE_EVIDENCE_INSUFFICIENT"])];
    return {...evaluated,ready:reasons.length===0,mode:reasons.length?"blocked":"active",reasons,
      detail:{...evaluated.detail,observationSource:"per-object-duration-bounded-evidence",
        priorAggregateAgeMs:age,priorAggregateTtlMs:ttl,freshness,hostConditions,
        noNetworkCalls:true,noRefresh:true}};
  }
  observedAt(): number | null { return this.cached?.at ?? null; }
  get maintenanceForced(): boolean { return Boolean(this.config.maintenanceForced); }
  invalidate(): void { this.cached = null; }
}

export interface ExecutionPresenceObservation {
  nodeId: string; sessionId: string | null; locatorRef: string | null; hytheId: string | null;
  hostKind: string | null; live: boolean; profile?: EffectControlProfile;
  reason?: string;
}
export interface ExecutionAdmission {
  ready: boolean; blocked: boolean; mode: "active" | "blocked"; reasons: string[];
  observedAt: number; detail: Record<string, unknown>;
}
/** Node-to-Node admission has no dependency on an unrelated Human frontend.
 * This read does not issue a permit: the existing final Effect boundary still
 * rechecks Authority, account binding, exact Session and generation at send. */
export function evaluateExecutionAdmission(db: DatabaseSync, input: {
  caller: ExecutionPresenceObservation; target: ExecutionPresenceObservation;
  ownerId?: string; ready: boolean; maintenanceForced?: boolean;
  capability?: "task.dispatch" | "self.task.resume";
  projectRef?:string;taskId?:string;
}): ExecutionAdmission {
  const reasons: string[] = [], detail: Record<string, unknown> = {}, capability = input.capability ?? "task.dispatch";
  const fail = (code: string) => { if (!reasons.includes(code)) reasons.push(code); };
  if (!input.ready) fail("CORE_INITIALIZING");
  if (input.maintenanceForced) fail("MAINTENANCE_FORCED");
  let worldId: string | null = null;
  try {
    worldId = recordWorld(db, "nodes", input.caller.nodeId);
    if (recordWorld(db, "nodes", input.target.nodeId) !== worldId) fail("WORLD_APPLICABLE");
  } catch { fail("WORLD_APPLICABLE"); }
  detail.worldId = worldId;
  if (!worldId || !db.prepare("SELECT 1 FROM sidera_worlds WHERE world_id=?").get(worldId)) fail("WORLD_APPLICABLE");
  if (!worldId || !db.prepare("SELECT 1 FROM world_humans w JOIN human_principals h USING(human_id) WHERE w.world_id=?").get(worldId))
    fail("HUMAN_WORLD_MEMBERSHIP");
  if (!worldId || !db.prepare("SELECT 1 FROM trust_policy WHERE world_id=?").get(worldId)) fail("EFFECT_GATE_EVALUABLE");
  if (!db.prepare("SELECT 1 FROM semantic_migrations WHERE migration_id='M1'").get()) fail("MIGRATION_MAINTENANCE");
  if (!input.ownerId || !db.prepare("SELECT 1 FROM execution_owners WHERE owner_id=? AND state='active'").get(input.ownerId))
    fail("GENERATION_FENCING");
  const unfenced = db.prepare(`SELECT count(*) n FROM task_runs r JOIN run_bases b USING(run_id)
    WHERE b.world_id=? AND r.turn_open=1 AND NOT EXISTS(SELECT 1 FROM run_execution_owners o
      JOIN execution_owners e USING(owner_id) WHERE o.run_id=r.run_id AND e.state='active')`).get(worldId)?.n;
  if (Number(unfenced) > 0) fail("GENERATION_FENCING");
  detail.openTurnsWithoutActiveOwner = Number(unfenced ?? 0);
  for (const [role, observed] of [["ACTOR", input.caller], ["TARGET", input.target]] as const) {
    const current = db.prepare(`SELECT s.session_id,s.locator_ref,s.hythe_id,s.host_kind,s.state FROM sessions s
      JOIN nodes n USING(node_id) WHERE s.node_id=? AND s.session_id=? AND n.lifecycle='active'`).get(observed.nodeId,observed.sessionId??"");
    const exact = Boolean(current && current.session_id === observed.sessionId && current.locator_ref === observed.locatorRef &&
      current.hythe_id === observed.hytheId && current.host_kind === observed.hostKind &&
      (current.state==="active"||isExecutorRuntimeSession(db,observed.nodeId,String(current.session_id))));
    if (!exact) fail(`${role}_SESSION_CHANGED`);
    if (!observed.live) fail(`${role}_PRESENCE`);
    if (observed.sessionId && !readSessionHostCondition(db,observed.sessionId).canExecute)
      fail(`${role}_SESSION_HEALTH_UNAVAILABLE`);
    const profile = observed.profile;
    if (!profile?.id || !profile.version || !profile.boundary || !profile.admission ||
      !["SideraControlled", "ProviderCancelable", "ProviderAutonomousNonCancelable"].includes(profile.control))
      fail(`${role}_EFFECT_CONTROL_PROFILE`);
    if (profile?.externalIdentityRequired && !db.prepare(`SELECT 1 FROM presence_accounts p
      JOIN external_identities i ON i.identity_id=p.identity_id AND i.world_id=p.world_id
      WHERE p.session_id=? AND p.world_id=? AND p.knowledge='bound' AND i.state='active'`).get(observed.sessionId, worldId))
      fail(`${role}_EXTERNAL_IDENTITY`);
    detail[role.toLowerCase()] = { nodeId: observed.nodeId, sessionId: observed.sessionId, locatorRef: observed.locatorRef,
      hytheId: observed.hytheId, live: observed.live, exact, profileId: profile?.id ?? null, reason: observed.reason ?? null };
  }
  if (capability === "self.task.resume" && input.caller.nodeId !== input.target.nodeId) fail("HUMAN_ROOTED_AUTHORITY");
  const dispatch = { subjectNodeId: input.caller.nodeId, sessionId: input.caller.sessionId ?? "", requestId: "execution-admission",
    capability, resource: capability === "self.task.resume" ? `node/${input.caller.nodeId}/runtime` : `node/${input.target.nodeId}`,
    product: input.target.hostKind ?? undefined, effectScope: "admission" as const,projectRef:input.projectRef,taskId:input.taskId };
  if (!canUseCapability(db, dispatch)) fail("HUMAN_ROOTED_AUTHORITY");
  if (capability === "task.dispatch" && !canUseCapability(db, { subjectNodeId: input.target.nodeId,
    sessionId: input.target.sessionId ?? "", requestId: "execution-return-admission", capability: "message.send",
    resource: `node/${input.caller.nodeId}`, product: input.caller.hostKind ?? undefined, effectScope: "admission",projectRef:input.projectRef,taskId:input.taskId })) fail("RETURN_AUTHORITY");
  return { ready: reasons.length === 0, blocked: reasons.length !== 0, mode: reasons.length ? "blocked" : "active",
    reasons, observedAt: Date.now(), detail };
}

export function evaluateActivation(db: DatabaseSync, input: ActivationInput): ActivationDecision {
  const prerequisites = Object.fromEntries(
    ACTIVATION_PREREQUISITES.map(name => [name, "unknown" as PrerequisiteState]),
  ) as Record<Prerequisite, PrerequisiteState>;
  const detail: Record<string, unknown> = {};
  const fail = (name: Prerequisite) => { prerequisites[name] = "unsatisfied"; };

  // --- WORLD_APPLICABLE -----------------------------------------------------
  const world = db.prepare("SELECT * FROM sidera_worlds WHERE world_id=?").get(input.worldId) as
    { world_id: string; label: string } | undefined;
  let chiefWorld: string | null = null;
  try { chiefWorld = recordWorld(db, "nodes", input.chiefNodeId); } catch { chiefWorld = null; }
  detail.world = world ? { worldId: world.world_id, label: world.label } : null;
  detail.worldOfChief = chiefWorld;
  if (!world || chiefWorld !== input.worldId) fail("WORLD_APPLICABLE");
  else prerequisites.WORLD_APPLICABLE = "satisfied";

  // --- HUMAN_PRINCIPAL / HUMAN_WORLD_MEMBERSHIP -----------------------------
  const human = db.prepare(`SELECT h.human_id, w.provenance AS membership_provenance
    FROM world_humans w JOIN human_principals h USING(human_id) WHERE w.world_id=? ORDER BY h.human_id LIMIT 1`)
    .get(input.worldId) as { human_id: string; membership_provenance: string } | undefined;
  detail.human = human ?? null;
  if (!human) fail("HUMAN_PRINCIPAL");
  else prerequisites.HUMAN_PRINCIPAL = "satisfied";
  if (human && !db.prepare("SELECT 1 FROM world_humans WHERE world_id=? AND human_id=?").get(input.worldId, human.human_id))
    fail("HUMAN_WORLD_MEMBERSHIP");
  else if (human) prerequisites.HUMAN_WORLD_MEMBERSHIP = "satisfied";

  // --- HUMAN_FRONTEND_BINDING / RETURN_ROUTE --------------------------------
  const binding = db.prepare(`SELECT binding_id,conversation_ref,frontend_kind,state FROM chief_conversations
    WHERE chief_node_id=? AND state='active'`).get(input.chiefNodeId) as
    { binding_id: string; conversation_ref: string; frontend_kind: string } | undefined;
  detail.binding = binding ?? null;
  if (!binding) fail("HUMAN_FRONTEND_BINDING");
  else prerequisites.HUMAN_FRONTEND_BINDING = "satisfied";
  // A source is active Human-frontend provenance for this World.
  const source = human ? db.prepare(`SELECT source_id,presence_ref FROM human_frontend_sources
    WHERE world_id=? AND human_id=? AND active=1 ORDER BY source_id LIMIT 1`)
    .get(input.worldId, human.human_id) as { source_id: string; presence_ref: string } | undefined : undefined;
  detail.humanSource = source ?? null;
  if (!source) fail("HUMAN_FRONTEND_PRESENCE");
  else if (input.live.frontendPresence !== "LIVE") fail("HUMAN_FRONTEND_PRESENCE");
  else prerequisites.HUMAN_FRONTEND_PRESENCE = "satisfied";
  // The route must be derivable from a current binding plus a current Presence.
  if (binding && source && input.live.frontendPresence === "LIVE") prerequisites.RETURN_ROUTE = "satisfied";
  else fail("RETURN_ROUTE");

  // The Chief is a Project Conversation role; the owning Node and execution context remain distinct.
  const node = db.prepare("SELECT node_id,lifecycle FROM nodes WHERE node_id=?").get(input.chiefNodeId) as
    { node_id: string; lifecycle: string } | undefined;
  const session = db.prepare(`SELECT session_id,node_id,locator_ref,hythe_id FROM sessions
    WHERE session_id=? AND node_id=? AND state='active'`).get(input.chiefSessionId, input.chiefNodeId) as
    { session_id: string; locator_ref: string; hythe_id: string } | undefined;
  detail.chiefConversation = binding?{bindingId:binding.binding_id,conversationRef:binding.conversation_ref,communicatorNodeRef:node?.node_id??null}:null;
  detail.executionContext = session ?? null;
  if (!binding || !node || node.lifecycle !== "active" || !session) fail("CHIEF_CONVERSATION_IDENTITY");
  else prerequisites.CHIEF_CONVERSATION_IDENTITY = "satisfied";
  if (input.live.chiefRuntimePresence !== "LIVE") fail("CHIEF_RUNTIME_PRESENCE");
  else prerequisites.CHIEF_RUNTIME_PRESENCE = "satisfied";

  // --- target identity / presence / control profile -------------------------
  const targets = new Set<string>();
  for (const requirement of input.required) {
    const match = /^node\/([^/*]+)/.exec(requirement.resource);
    if (match) targets.add(match[1]);
  }
  const missingTargets = [...targets].filter(id => prerequisites.WORLD_APPLICABLE === "satisfied" &&
    (() => { try { return recordWorld(db, "nodes", id) !== input.worldId; } catch { return true; } })());
  const foreignTargets = [...targets].filter(id => !db.prepare("SELECT 1 FROM nodes WHERE node_id=? AND lifecycle='active'").get(id));
  detail.targets = [...targets];
  if (missingTargets.length || foreignTargets.length) { detail.missingTargets = missingTargets; detail.foreignTargets = foreignTargets; }
  else prerequisites.TARGET_NODE_IDENTITY = "satisfied";
  if (prerequisites.TARGET_NODE_IDENTITY !== "satisfied") fail("TARGET_NODE_IDENTITY");
  const presence = input.live.targetPresence ?? {};
  const meshTargets = Object.keys(presence);
  const unavailableMeshTargets = meshTargets.filter(id => presence[id] !== "LIVE");
  detail.mesh = { complete: meshTargets.length > 0 && unavailableMeshTargets.length === 0,
    condition: meshTargets.length === 0 ? "MESH_NOT_OBSERVED" : unavailableMeshTargets.length ? "MESH_INCOMPLETE" : "MESH_PRESENCE_COMPLETE",
    targetPresence: presence, unavailableTargets: unavailableMeshTargets };
  const staleTargets = [...targets].filter(id => presence[id] !== "LIVE");
  detail.staleTargets = staleTargets;
  if (!targets.size) prerequisites.TARGET_PRESENCE = "satisfied";
  else if (staleTargets.length) fail("TARGET_PRESENCE");
  else prerequisites.TARGET_PRESENCE = "satisfied";

  // --- HUMAN_ROOTED_AUTHORITY ----------------------------------------------
  const profiles = input.live.effectProfiles ?? {};
  const denied: Array<{ capability: string; resource: string }> = [];
  const unprofiled: string[] = [];
  for (const requirement of input.required) {
    if (!humanRootedFor(db, input.chiefNodeId, input.worldId, requirement)) denied.push(requirement);
    const target = /^node\/([^/*]+)/.exec(requirement.resource)?.[1];
    if (target && targets.has(target) && !profiles[target]) unprofiled.push(target);
  }
  detail.denied = denied;
  if (denied.length) fail("HUMAN_ROOTED_AUTHORITY");
  else prerequisites.HUMAN_ROOTED_AUTHORITY = "satisfied";
  const deniedReturnTargets=[...targets].filter(id=>input.required.some(r=>r.capability==="task.dispatch" && r.resource===`node/${id}`) &&
    !humanRootedFor(db,id,input.worldId,{capability:"message.send",resource:`node/${input.chiefNodeId}`}));
  detail.deniedReturnTargets=deniedReturnTargets;
  if(deniedReturnTargets.length)fail("RETURN_AUTHORITY");else prerequisites.RETURN_AUTHORITY="satisfied";

  // --- EFFECT_CONTROL_PROFILE / EFFECT_GATE_EVALUABLE -----------------------
  detail.unprofiledTargets = [...new Set(unprofiled)];
  detail.frontendEffectProfile = input.live.frontendEffectProfile ?? null;
  if (unprofiled.length || !input.live.frontendEffectProfile) fail("EFFECT_CONTROL_PROFILE");
  else prerequisites.EFFECT_CONTROL_PROFILE = "satisfied";
  const trust = db.prepare("SELECT delegation_enabled FROM trust_policy WHERE world_id=?").get(input.worldId) as
    { delegation_enabled: number } | undefined;
  detail.trustPolicy = trust ?? null;
  const missingIdentities=[...targets].filter(id=>input.live.effectIdentityRequired?.[id] && !db.prepare(`SELECT 1 FROM sessions s
    JOIN presence_accounts p USING(session_id) JOIN external_identities i ON i.identity_id=p.identity_id AND i.world_id=p.world_id
    WHERE s.node_id=? AND s.state='active' AND p.world_id=? AND p.knowledge='bound' AND i.state='active'`).get(id,input.worldId));
  const frontendIdentityKnown=!input.live.frontendIdentityRequired || Boolean(binding && db.prepare(`SELECT 1 FROM frontend_accounts p
    JOIN external_identities i ON i.identity_id=p.identity_id AND i.world_id=p.world_id
    WHERE p.binding_id=? AND p.world_id=? AND p.knowledge='bound' AND i.state='active'`).get(binding.binding_id,input.worldId));
  detail.missingExternalIdentities=missingIdentities;detail.frontendIdentityKnown=frontendIdentityKnown;
  // The gate is evaluable only when the World carries a trust policy and every
  // required target declares a control profile (above).
  if (!trust || missingIdentities.length || !frontendIdentityKnown) fail("EFFECT_GATE_EVALUABLE");
  else prerequisites.EFFECT_GATE_EVALUABLE = prerequisites.EFFECT_CONTROL_PROFILE;

  // --- GENERATION_FENCING ---------------------------------------------------
  const ownerless = db.prepare(`SELECT COUNT(*) AS n FROM task_runs r WHERE r.turn_open=1
    AND NOT EXISTS(SELECT 1 FROM run_execution_owners o WHERE o.run_id=r.run_id)`).get() as { n: number };
  detail.openTurnsWithoutOwner = ownerless.n;
  if (ownerless.n > 0) fail("GENERATION_FENCING");
  else prerequisites.GENERATION_FENCING = "satisfied";

  // --- MIGRATION_MAINTENANCE -----------------------------------------------
  const migration = db.prepare(`SELECT compatibility_world_id,provenance FROM semantic_migrations WHERE migration_id='M1'`).get() as
    { compatibility_world_id: string; provenance: string } | undefined;
  detail.migration = migration ?? null;
  // Writes that were never explicitly scoped must stay in the compatibility
  // container; an active World must not be silently substituted for them.
  const unscoped = db.prepare(`SELECT COUNT(*) AS n FROM world_records WHERE world_id=?`).get(input.worldId) as { n: number };
  detail.unscopedRecordsInWorld = unscoped.n;
  prerequisites.MIGRATION_MAINTENANCE = migration ? "satisfied" : "unsatisfied";
  if (!migration) fail("MIGRATION_MAINTENANCE");

  // Default-deny: an undecided prerequisite is never treated as satisfied.
  for (const name of ACTIVATION_PREREQUISITES)
    if (prerequisites[name] === "unknown") prerequisites[name] = "unsatisfied";
  const reasons = ACTIVATION_PREREQUISITES.filter(name => prerequisites[name] !== "satisfied").map(String);
  if (input.maintenanceForced) reasons.push("MAINTENANCE_FORCED");
  return {
    ready: reasons.length === 0,
    mode: reasons.length === 0 ? "active" : "blocked",
    reasons,
    prerequisites,
    detail,
  };
}

/** A capability is usable only through a grant whose Human root is admitted and applied. */
export function humanRootedFor(db: DatabaseSync, nodeId: string, worldId: string,
  requirement: { capability: string; resource: string; product?: string; effectScope?: string }): boolean {
  try { if (recordWorld(db, "nodes", nodeId) !== worldId) return false; } catch { return false; }
  if (requirement.effectScope !== undefined && requirement.effectScope !== "admission" &&
      requirement.effectScope !== "post_admission_revocable") return false;
  const session = db.prepare("SELECT session_id FROM sessions WHERE node_id=? AND state='active'").get(nodeId);
  if (!session) return false;
  // Use the same read-only authority path as dispatch: resource /** and
  // capability .* are different scopes, and constraints/budgets remain binding.
  return canUseCapability(db, { subjectNodeId: nodeId, sessionId: String(session.session_id),
    requestId: "activation-authority-read", ...requirement, effectScope: requirement.effectScope });
}
