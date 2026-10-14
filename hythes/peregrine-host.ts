import type { DatabaseSync } from "node:sqlite";
import type { EffectControlProfile } from "../core/effect-gate.ts";
import { SideraError } from "../core/types.ts";
import type { LocalPeregrineManager } from "../peregrine/local.ts";
import { runLocalTask } from "../peregrine/task.ts";
import { hostManifest, type CapabilityManifest } from "./manifest.ts";
import type { HostMessage, Hythe, InvokeResult } from "./types.ts";

export interface PeregrineHostOptions {
  hytheId: string; nodeId: string; sessionId: string;
  db: DatabaseSync; manager: LocalPeregrineManager;
}

interface PendingTask {
  messageId: string; taskId: string; hostRef: string;
  promise: Promise<HostMessage>;
}

/**
 * Built-in local Host. It is the publicly distributable executor Sidera can
 * run without any private bridge, cloud account or third-party product.
 *
 * The Host owns no Authority of its own: Core has already admitted the Task,
 * pinned this exact Session and crossed the Bus Effect boundary before
 * `invoke` is called. Each task body is a bounded JSON instruction executed by
 * `peregrine/task.ts` inside the Node's contained workspace. Evidence carries
 * content hashes and process receipts; a started action without a completed
 * marker is UNCERTAIN and is never replayed.
 */
export class PeregrineHostHythe implements Hythe {
  readonly hytheId: string;
  readonly hostKind = "peregrine-local";
  private readonly db: DatabaseSync;
  private readonly manager: LocalPeregrineManager;
  private readonly nodeId: string;
  private readonly sessionId: string;
  private readonly results: HostMessage[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly pending = new Map<string, PendingTask>();
  private closed = false;

  constructor(options: PeregrineHostOptions) {
    if (!options.hytheId?.trim()) throw new Error("Peregrine Host requires a Hythe identity");
    this.hytheId = options.hytheId;
    this.db = options.db;
    this.manager = options.manager;
    this.nodeId = options.nodeId;
    this.sessionId = options.sessionId;
  }

  capabilities(): readonly string[] { return ["message.receive"]; }
  canStartTurn(): boolean { return true; }
  /** A non-starting exact probe: the manager is already owned by this Core. */
  readonly inspectExactHost = async (_locatorRef: string): Promise<boolean> => !this.closed;
  async locate(_locatorRef: string): Promise<boolean> { return !this.closed; }

  effectProfile(operation: string): EffectControlProfile | undefined {
    if (operation !== "message.receive" && operation !== "session.locate") return undefined;
    return {
      id: "peregrine-local:controlled-execution", version: "1", control: "SideraControlled",
      boundary: "Core admits the exact Task, pins this Session and crosses the Bus Effect boundary before the bounded local instruction starts",
      admission: "Exact task message in this Node's own admitted Session; instruction is bounded JSON with no shell or arbitrary path",
      businessEffects: ["Creates or replaces one simple-named file inside the Node's contained Peregrine workspace",
        "Optionally runs one bounded script with the bundled Node executable in that same workspace"],
      cancellation: "The owning Core can stop the Peregrine process tree; a killed run leaves its start marker and stays UNCERTAIN",
      uncertainInterval: "From the durable local.executor.started marker until local.executor.completed is durable",
      externalIdentityRequired: false,
    };
  }

  manifest(): CapabilityManifest {
    return hostManifest(this, { routeClass: "protocol", operations: ["session.inspect"],
      createsSession: false, transportCapabilities: ["message.receive", "session.locate"] });
  }

  diagnostics(): Record<string, unknown> {
    return { mode: "built-in-local-executor", nodeId: this.nodeId, sessionId: this.sessionId,
      pending: this.pending.size, queuedResults: this.results.length,
      workspace: "contained peregrine workspace", externalAccountsRequired: false };
  }

  async invoke(locatorRef: string, capability: string, input: unknown, _requestId: string,
    boundary?: import("../core/effect-gate.ts").EffectBoundary): Promise<InvokeResult> {
    const payload = input as { messageId?: unknown; taskId?: unknown; kind?: unknown; targetSessionId?: unknown };
    if (capability !== "message.receive")
      return { status: "rejected", reason: "Peregrine local Host accepts only message.receive" };
    if (payload.kind !== "task" || typeof payload.messageId !== "string" || !payload.messageId)
      return { status: "rejected", reason: "Peregrine local Host executes only exact task deliveries" };
    if (payload.targetSessionId !== this.sessionId)
      return { status: "rejected", reason: "Peregrine local Host is not the pinned target Session" };
    if (!boundary)
      return { status: "rejected", reason: "Peregrine local Host requires the Core Effect boundary" };
    const messageId = payload.messageId, taskId = String(payload.taskId ?? "");
    const hostRef = `peregrine:${messageId}`;
    const existing = this.pending.get(messageId);
    if (existing) return { status: "accepted", hostRef };
    return boundary.cross({ product: this.hostKind, locator: locatorRef, operation: "message.receive" }, () => {
      const promise = runLocalTask(this.db, this.manager, { nodeId: this.nodeId, sessionId: this.sessionId }, { messageId })
        .then((evidence): HostMessage => ({ hostRef, observedMessageId: messageId,
          body: JSON.stringify(evidence), outcome: evidence.status === "completed" ? "completed" : "failed" }))
        .catch((error): HostMessage => ({ hostRef, observedMessageId: messageId,
          body: JSON.stringify({ status: "failed", code: error instanceof SideraError ? error.code : "unavailable",
            message: error instanceof Error ? error.message : "Local execution failed" }), outcome: "failed" }));
      const pending: PendingTask = { messageId, taskId, hostRef, promise };
      this.pending.set(messageId, pending);
      void promise.then(result => {
        this.pending.delete(messageId);
        if (!this.closed) { this.results.push(result); for (const wake of this.waiters.splice(0)) wake(); }
      });
      return { status: "accepted", hostRef } as InvokeResult;
    });
  }

  /** Stream one terminal result per executed task. Stays subscribed until the
   * owning Core closes; a result is never emitted twice for one message. */
  async *receive(_locatorRef: string, _cursor?: string): AsyncGenerator<HostMessage> {
    while (!this.closed) {
      const next = this.results.shift();
      if (next) { yield next; continue; }
      await new Promise<void>(resolve => { this.waiters.push(resolve); });
    }
  }

  /** Exact terminal read of durable evidence. A restarted Core reconciles the
   * original Run through this instead of replaying the local action. */
  async completedTurn(_locatorRef: string, hostRef: string, messageId: string): Promise<HostMessage | null> {
    const row = this.db.prepare(`SELECT payload FROM events WHERE actor_node_id = ?
      AND kind = 'local.executor.completed' AND json_extract(payload, '$.messageId') = ?
      ORDER BY rowid DESC LIMIT 1`).get(this.nodeId, messageId) as { payload: string } | undefined;
    if (!row) return null;
    const evidence = (JSON.parse(String(row.payload)) as { evidence?: Record<string, unknown> }).evidence;
    if (!evidence) return null;
    return { hostRef, observedMessageId: messageId, body: JSON.stringify(evidence),
      outcome: evidence.status === "completed" ? "completed" : "failed" };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
  }
}
