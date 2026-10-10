import { join } from "node:path";
import { openDatabase } from "../../core/db.ts";
import { CoreRuntime } from "./execution.ts";
import type { Hythe } from "../../hythes/types.ts";
const db=openDatabase(join(process.env.SIDERA_PROJECT_ROOT!,".sidera-dev","sol","data","sidera.sqlite"));
db.prepare("INSERT INTO nodes VALUES ('worker','worker','active','now')").run();
db.prepare("INSERT INTO sessions VALUES ('exact-session','worker','fixture','fixture','exact-locator','active','now')").run();
const hythe:Hythe={hytheId:"fixture",hostKind:"fixture",capabilities:()=>["message.receive"],locate:async()=>true,
 invoke:async()=>({status:"accepted",hostRef:"accepted-real-child"}),async *receive(){}};
const runtime=new CoreRuntime(db,new Map([["fixture",hythe]]),undefined,{observationOnly:true});
const submitted=runtime.continuations.submit({requestId:"independent-child",originNodeId:"worker",originSessionId:"exact-session",
 centerNodeId:"worker",workerNodeIds:[],body:"No external effect; process loss evidence fixture",authorityCapability:"self.task.resume"});
await runtime.continuations.pump();
process.send?.({runId:submitted.run.run_id,taskId:submitted.task.taskId});
process.on("message",()=>{}); // IPC keeps this synthetic execution open until its exact child is killed.
