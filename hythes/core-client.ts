import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CoreClientConfig {
  port: number;
  token: string;
  /** Configured by the frontend adapter, never selected from tool-generated args. */
  chiefConversationRef?: string;
  /** Private, explicit last-known observation cache. Never canonical Task state. */
  observationCachePath?: string;
}

export interface DispatchOutcome {
  taskId: string;
  firstMessageId: string;
  deliveryState: string;
  result?: { body: string; messageId: string; state: string };
  waitingForResult: boolean;
}

/** One task action is one Sidera RPC; the result is pushed on that connection. */
export async function dispatchAndWait(config: CoreClientConfig, input: {
  requestId: string;
  centerNodeId: string;
  workerNodeIds: string[];
  body: string;
  waitMs?: number;
}): Promise<DispatchOutcome> {
  const socket = createConnection({ host: "127.0.0.1", port: config.port });
  let buffer = "";
  let taskId: string | null = null;
  let firstMessageId: string | null = null;
  let deliveryState: string | null = null;
  const pushed = new Map<string, { body: string; messageId: string;
    state: string; kind: "result" | "status" }>();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: DispatchOutcome | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      if (!taskId || !firstMessageId || !deliveryState) {
        finish(new Error("Sidera dispatch result is uncertain"));
      } else {
        finish({ taskId, firstMessageId, deliveryState, waitingForResult: true });
      }
    }, input.waitMs ?? 10 * 60_000);
    socket.once("error", () => finish(new Error("Sidera connection failed")));
    socket.once("close", () => {
      if (!settled) finish(new Error("Sidera result channel closed; outcome is uncertain"));
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        id: 1, token: config.token, method: "task.submit",
        params: { requestId: input.requestId, centerNodeId: input.centerNodeId,
          workerNodeIds: input.workerNodeIds, body: input.body },
      })}\n`);
    });
    socket.on("data", chunk => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let event: any;
        try { event = JSON.parse(line); } catch { finish(new Error("Invalid Sidera response")); return; }
        if (event.id === 1) {
          if (event.error) { finish(new Error(`Sidera ${event.error.code}`)); return; }
          taskId = event.result?.task?.taskId ?? null;
          firstMessageId = event.result?.firstMessage?.messageId ?? event.result?.run?.message_id ?? null;
          deliveryState = event.result?.firstMessage?.state ?? (event.result?.run ? "queued" : null);
          if (!taskId || !firstMessageId || !deliveryState) {
            finish(new Error("Incomplete Sidera dispatch response")); return;
          }
          const result = pushed.get(taskId);
          if (result) {
            finish({ taskId, firstMessageId,
              deliveryState: result.kind === "status" ? result.state : deliveryState,
              result: result.kind === "result" ? result : undefined,
              waitingForResult: result.kind === "status" });
          } else if (["failed","uncertain"].includes(deliveryState)) {
            finish({ taskId, firstMessageId, deliveryState, waitingForResult: true });
          }
        } else if (event.method === "task.result" || event.method === "task.status") {
          const result = event.params as { taskId: string; body: string;
            messageId: string; state: string };
          const kind = event.method === "task.result" ? "result" : "status";
          pushed.set(result.taskId, { ...result, kind });
          if (result.taskId === taskId && taskId && firstMessageId && deliveryState) {
            finish({ taskId, firstMessageId,
              deliveryState: kind === "status" ? result.state : deliveryState,
              result: kind === "result" ? result : undefined,
              waitingForResult: kind === "status" });
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
  });
}

const observations=new WeakMap<CoreClientConfig,Map<string,{at:string;view:unknown}>>();
export async function getReadView(config: CoreClientConfig, method:"task.get"|"chief.status", params:Record<string,unknown>): Promise<unknown> {
  const taskId=`${method}:${JSON.stringify(params)}`;
  const cache=observations.get(config) ?? new Map();observations.set(config,cache);
  if(config.observationCachePath&&!cache.size)try{for(const [id,value] of Object.entries(JSON.parse(readFileSync(config.observationCachePath,"utf8"))))cache.set(id,value);}catch{/* Cache absent is not a Task failure. */}
  try{const view=await callCore(config,method,params);cache.set(taskId,{at:new Date().toISOString(),view});
    if(config.observationCachePath)try{mkdirSync(dirname(config.observationCachePath),{recursive:true});
      const temp=`${config.observationCachePath}.${randomUUID()}.tmp`;writeFileSync(temp,JSON.stringify(Object.fromEntries(cache)));renameSync(temp,config.observationCachePath);
    }catch{/* A cache write failure cannot change a confirmed observation. */}
    return view;}
  catch(error){if(error instanceof Error&&/denied|not_found/.test(error.message))throw error;
    const known=cache.get(taskId);return {lastKnown:known?.view ?? null,lastKnownAt:known?.at ?? null,observation:known?"last-known":"unavailable",
    observationAvailable:false,taskStateChanged:false,rawRouteErrors:[error instanceof Error?error.message:String(error)]};}
}

export async function getTaskView(config:CoreClientConfig,taskId:string){return getReadView(config,"task.get",{taskId});}

/** One authenticated Core action; never retries an unconfirmed request. */
export async function callCore(config: CoreClientConfig, method: string,
  params: Record<string, unknown>): Promise<unknown> {
  const socket = createConnection({ host: "127.0.0.1", port: config.port });
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("uncertain: Core response timed out; do not resend")); },
      35_000);
    socket.once("error", () => { clearTimeout(timer); reject(new Error("uncertain: Core connection failed; do not resend")); });
    socket.once("close", () => { clearTimeout(timer); reject(new Error("uncertain: Core connection closed; do not resend")); });
    socket.once("connect", () => socket.write(`${JSON.stringify({
      id, token: config.token, method, params,
    })}\n`));
    socket.on("data", chunk => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let event: any;
        try { event = JSON.parse(line); }
        catch { clearTimeout(timer); socket.destroy(); reject(new Error("uncertain: invalid Core response")); return; }
        if (event.id === id) {
          clearTimeout(timer); socket.destroy();
          if (event.error) reject(new Error(`Sidera ${event.error.code}: ${event.error.message}`));
          else resolve(event.result);
          return;
        }
        newline = buffer.indexOf("\n");
      }
    });
  });
}

/** One boundary connection probe, before recovery; deadline is not a logical runtime clock. */
export function hasCoreOwner(port:number):Promise<boolean> {
 return new Promise((resolve,reject)=>{
  const socket=createConnection({host:"127.0.0.1",port});socket.setTimeout(3000);
  socket.once("connect",()=>{socket.destroy();resolve(true);});
  socket.once("error",error=>{socket.destroy();if((error as NodeJS.ErrnoException).code==="ECONNREFUSED")resolve(false);else reject(error);});
  socket.once("timeout",()=>{socket.destroy();reject(new Error("Core owner probe is unavailable; do not start another owner"));});
 });
}
