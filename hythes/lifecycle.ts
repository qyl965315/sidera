export interface LifecycleEvent { state: "unavailable"; reason: string; locatorRef?: string }
/** Host process/socket events; no Core polling. */
export class HostLifecycle {
  private listeners = new Set<(event: LifecycleEvent) => void>();
  subscribe(listener: (event: LifecycleEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  lost(reason: string, locatorRef?: string) { for (const listener of this.listeners) listener({state:"unavailable",reason,locatorRef}); }
}
