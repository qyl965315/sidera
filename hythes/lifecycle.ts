import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Opaque witness created only by a bound ChildProcess `exit` notification. */
export interface PhysicalHostExit {
  readonly receiptId: string;
  readonly pid: number | null;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly observedAt: string;
}
const trustedPhysicalExits=new WeakSet<object>();
export function isTrustedPhysicalHostExit(value: unknown): value is PhysicalHostExit {
  return typeof value==="object" && value!==null && trustedPhysicalExits.has(value);
}

export interface LifecycleEvent {
  state: "unavailable"; reason: string; locatorRef?: string;
  /** Present only for a witnessed local child-process exit, never a disconnect. */
  physicalExit?: PhysicalHostExit;
}
/** Host process/socket events; no Core polling. */
export class HostLifecycle {
  private listeners = new Set<(event: LifecycleEvent) => void>();
  subscribe(listener: (event: LifecycleEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  lost(reason: string, locatorRef?: string) { for (const listener of this.listeners) listener({state:"unavailable",reason,locatorRef}); }
  /** Bind confirmed loss to Node's actual child-process exit, not transport state. */
  watchChildExit(child: Pick<ChildProcess,"once"|"pid">,reason:string,locatorRef?:string,
    isCurrent: ()=>boolean=()=>true,afterExit?: (code:number|null,signal:NodeJS.Signals|null)=>void):void {
    child.once("exit",(code,signal)=>{
      if(!isCurrent())return;
      const physicalExit=Object.freeze({receiptId:randomUUID(),pid:child.pid??null,code,signal,observedAt:new Date().toISOString()});
      trustedPhysicalExits.add(physicalExit);
      for(const listener of this.listeners) listener({state:"unavailable",reason,locatorRef,physicalExit});
      afterExit?.(code,signal);
    });
  }
}
