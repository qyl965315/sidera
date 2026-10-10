import type { DatabaseSync } from "node:sqlite";
import type { Hythe } from "../hythes/types.ts";
import { Registry,registryAuthority } from "./registry.ts";
import { createHostResource } from "./session-effects.ts";
import { continueBoundHostIdentity } from "./session-presence.ts";
import { withTransaction } from "./db.ts";
import { randomUUID } from "node:crypto";
import { isExecutorRuntimeSession } from "./executors.ts";
import {recordConfirmedHostHandoff} from "./host-health.ts";

/** A Host supplies its strategy; Core applies the same authorized handoff to every Host. */
export function sessionStrategy(db:DatabaseSync,hythes:ReadonlyMap<string,Hythe>,receive:(id:string)=>Promise<void>) {
  const registry=new Registry(db,{authorize:registryAuthority(db),getHythe:id=>hythes.get(id)});
  return async (runId:string,sessionId:string,commitWake:(nextSessionId:string)=>void):Promise<string>=>{
    const prior=registry.getSession(sessionId),hythe=hythes.get(prior.hytheId);
    if (!hythe?.prepareWake) return sessionId;
    if(hythe.needsFreshWake?.(prior.locatorRef)===false)return sessionId;
    if(prior.state!=="active"&&isExecutorRuntimeSession(db,prior.nodeId,sessionId))
      throw new Error("Parallel Executor requires an exact reviewed replacement context; default-context handoff is ineligible");
    if (db.prepare("SELECT 1 FROM task_runs WHERE session_id=? AND (turn_open=1 OR state='uncertain')").get(sessionId))
      throw new Error("Fresh wake requires a quiescent exact Session");
    const intent=db.prepare("SELECT state,to_session_id FROM runtime_wakes WHERE run_id=?").get(runId) as {state:string;to_session_id:string}|undefined;
    if (intent) {if(intent.state==="ready") return intent.to_session_id;throw new Error("Wake intent is unresolved; never replay");}
    db.prepare("INSERT INTO runtime_wakes VALUES (?,?,NULL,'intent',?)").run(runId,sessionId,new Date().toISOString());
    try {
      const locator=await createHostResource(db,hythe,{nodeId:prior.nodeId,sessionId,requestId:`wake-create:${runId}`,runId},
        boundary=>hythe.prepareWake!(prior.locatorRef,boundary));
      if (locator===prior.locatorRef) {db.prepare("DELETE FROM runtime_wakes WHERE run_id=?").run(runId);return sessionId;}
      const context={actorNodeId:prior.nodeId,actorSessionId:sessionId,resourceScope:`node/${prior.nodeId}`};
      const next=await registry.bindSession({...context,requestId:`wake-bind:${runId}`},{nodeId:prior.nodeId,hytheId:prior.hytheId,hostKind:prior.hostKind,locatorRef:locator,state:"standby"});
      await registry.handoffSession({...context,requestId:`wake-handoff:${runId}`},prior.nodeId,next.sessionId,sessionId,()=>{
        continueBoundHostIdentity(db,{fromSessionId:sessionId,toSessionId:next.sessionId,requestId:`wake-handoff:${runId}`,
          source:"Human-bound Host identity on fresh-wake Session handoff"});
        commitWake(next.sessionId);
        db.prepare("UPDATE runtime_wakes SET state='ready',to_session_id=? WHERE run_id=?").run(next.sessionId,runId);
      });
      recordConfirmedHostHandoff(db,next.sessionId,`wake-handoff:${runId}`);
      void receive(next.sessionId).catch(()=>{});return next.sessionId;
    } catch(error) {db.prepare("UPDATE runtime_wakes SET state='uncertain' WHERE run_id=?").run(runId);throw error;}
  };
}

/** Fresh Host Session for a non-Run wake such as a root result/supervision review.
 * The wake identity is durable and caller-supplied; no provider work is replayed. */
export function nodeWakeStrategy(db:DatabaseSync,hythes:ReadonlyMap<string,Hythe>,receive:(id:string)=>Promise<void>) {
  const registry=new Registry(db,{authorize:registryAuthority(db),getHythe:id=>hythes.get(id)});
  return async (wakeId:string,nodeId:string,sessionId:string,commitWake?:(nextSessionId:string)=>void):Promise<string>=>{
    const intent=db.prepare("SELECT state,to_session_id FROM node_wakes WHERE wake_id=?").get(wakeId) as
      {state:string;to_session_id:string|null}|undefined;
    if(intent){
      if(intent.state==="ready"&&intent.to_session_id)return intent.to_session_id;
      throw new Error("Node wake intent is unresolved; never replay");
    }
    let prior=registry.getSession(sessionId);
    if(prior.nodeId!==nodeId)throw new Error("Wake Session belongs to another Node");

    // A queued, unsent standalone wake may still point at a Session that was
    // legitimately retired by a later authorized handoff. Follow the Node's
    // current active Session atomically; this is routing continuity, not a replay.
    if(prior.state!=="active"&&!isExecutorRuntimeSession(db,nodeId,sessionId)){
      const active=registry.getActiveSession(nodeId);
      if(!active)throw new Error("Wake Node has no active Session");
      withTransaction(db,"node_wake_follow_active",()=>{
        db.prepare("INSERT INTO node_wakes VALUES (?,?,?,?,'ready',?)")
          .run(wakeId,nodeId,sessionId,active.sessionId,new Date().toISOString());
        commitWake?.(active.sessionId);
        db.prepare("INSERT INTO events VALUES (?,?,'node.wake_followed_active',?,?)").run(randomUUID(),nodeId,
          JSON.stringify({wakeId,previousSessionId:sessionId,nextSessionId:active.sessionId,replay:false}),
          new Date().toISOString());
      });
      return active.sessionId;
    }

    const hythe=hythes.get(prior.hytheId);
    if(!hythe?.prepareWake || hythe.needsFreshWake?.(prior.locatorRef)===false)return sessionId;
    if(prior.state!=="active")throw new Error("Parallel Executor requires an exact reviewed replacement context; default-context handoff is ineligible");
    if(db.prepare("SELECT 1 FROM task_runs WHERE session_id=? AND (turn_open=1 OR state='uncertain')").get(sessionId))
      throw new Error("Fresh node wake requires a quiescent exact Session");
    db.prepare("INSERT INTO node_wakes VALUES (?,?,?,NULL,'intent',?)")
      .run(wakeId,nodeId,sessionId,new Date().toISOString());
    try{
      const locator=await createHostResource(db,hythe,{nodeId,sessionId,requestId:"node-wake-create:"+wakeId},
        boundary=>hythe.prepareWake!(prior.locatorRef,boundary));
      if(locator===prior.locatorRef){
        db.prepare("DELETE FROM node_wakes WHERE wake_id=?").run(wakeId);
        return sessionId;
      }
      const context={actorNodeId:nodeId,actorSessionId:sessionId,resourceScope:"node/"+nodeId};
      const next=await registry.bindSession({...context,requestId:"node-wake-bind:"+wakeId},
        {nodeId,hytheId:prior.hytheId,hostKind:prior.hostKind,locatorRef:locator,state:"standby"});
      await registry.handoffSession({...context,requestId:"node-wake-handoff:"+wakeId},nodeId,next.sessionId,sessionId,()=>{
        continueBoundHostIdentity(db,{fromSessionId:sessionId,toSessionId:next.sessionId,
          requestId:"node-wake-handoff:"+wakeId,source:"Human-bound Host identity on standalone fresh-wake Session handoff"});
        commitWake?.(next.sessionId);
        db.prepare("UPDATE node_wakes SET state='ready',to_session_id=? WHERE wake_id=?").run(next.sessionId,wakeId);
      });
      recordConfirmedHostHandoff(db,next.sessionId,`node-wake-handoff:${wakeId}`);
      void receive(next.sessionId).catch(()=>{});
      return next.sessionId;
    }catch(error){
      db.prepare("UPDATE node_wakes SET state='uncertain' WHERE wake_id=?").run(wakeId);
      throw error;
    }
  };
}
