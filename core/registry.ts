import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Hythe } from "../hythes/types.ts";
import { reserveCapability, settleReservation, type Permit } from "./authority.ts";
import { SideraError, type NodeRecord, type SessionRecord } from "./types.ts";
import { recordWorld, scopeNewNode } from "./worlds.ts";
import { initializeNodeSovereignty } from "./sovereignty-store.ts";
import { registerNodeOntology } from "./ontology.ts";

export interface RegistryWriteContext {
  actorNodeId: string;
  actorSessionId?: string;
  requestId: string;
  resourceScope: string;
}

export type RegistryCapability =
  | "node.create" | "node.retire"
  | "session.bind" | "session.handoff" | "session.close";

export interface RegistryDependencies {
  /** Trusted Core adapter: evaluate caller, scope and any task/budget context.
   * Called synchronously immediately before mutation; no implicit self/root bypass.
   */
  authorize(input: RegistryWriteContext & {
    capability: RegistryCapability;
    resource: string;
  }): boolean | Permit;
  getHythe(hytheId: string): Pick<Hythe, "hytheId" | "hostKind" | "locate"> | undefined;
}

export interface BindSessionInput {
  nodeId: string;
  hytheId: string;
  hostKind: string;
  locatorRef: string;
  /** Defaults to standby. Switching an existing active session requires handoff. */
  state?: "active" | "standby";
}

const nodeColumns = `n.node_id AS nodeId, n.display_name AS displayName,
  n.lifecycle, n.created_at AS createdAt, i.identity_metadata AS identityMetadata,
  i.self_state AS selfState, i.active_self_head AS activeSelfHead,
  i.lineage_ref AS lineageRef`;
const sessionColumns = `session_id AS sessionId, node_id AS nodeId,
  hythe_id AS hytheId, host_kind AS hostKind, locator_ref AS locatorRef,
  state, created_at AS createdAt`;

/** SQLite is canonical. Reads return snapshots, never cached mutable records.
 * Errors carry SideraError.code for RPC serialization. requestId is forwarded to
 * Authority; registry writes do not promise request replay deduplication.
 * Authorization resources: "nodes" for creation, "node/<nodeId>" otherwise.
 */
export class Registry {
  private readonly db: DatabaseSync;
  private readonly dependencies: RegistryDependencies;

  constructor(db: DatabaseSync, dependencies: RegistryDependencies) {
    this.db = db;
    this.dependencies = dependencies;
  }

  createNode(context: RegistryWriteContext, displayName: string,
    identityMetadata: Record<string, unknown> = {}): NodeRecord {
    this.nonempty(displayName, "displayName");
    const kind = identityMetadata.nodeKind;
    const operatorKind = identityMetadata.operatorKind;
    if (kind !== undefined && kind !== "Communicator" && kind !== "Operator")
      throw new SideraError("conflict", "Node kind must be Communicator or Operator");
    if (operatorKind !== undefined && operatorKind !== "Agent" && operatorKind !== "Bot")
      throw new SideraError("conflict", "Operator kind must be Agent or Bot");
    return this.write(context, "node.create", "nodes", () => {
      const nodeId = randomUUID();
      // Trusted historical bootstrap adapters have no Node identity. Their writes
      // retain the explicit compatibility World provenance supplied by the DB.
      if (this.db.prepare("SELECT 1 FROM nodes WHERE node_id=?").get(context.actorNodeId))
        scopeNewNode(this.db, recordWorld(this.db, "nodes", context.actorNodeId), nodeId);
      this.db.prepare(`INSERT INTO nodes VALUES (?, ?, 'active', ?)`)
        .run(nodeId, displayName, new Date().toISOString());
      this.db.prepare("UPDATE node_identity SET identity_metadata = ? WHERE node_id = ?")
        .run(JSON.stringify(identityMetadata), nodeId);
      registerNodeOntology(this.db, nodeId, { kind, operatorKind });
      initializeNodeSovereignty(this.db, nodeId);
      return this.getNode(nodeId);
    });
  }

  getNode(nodeId: string): NodeRecord {
    return this.read(() => {
      const row = this.db.prepare(`SELECT ${nodeColumns} FROM nodes n
        JOIN node_identity i ON i.node_id = n.node_id WHERE n.node_id = ?`)
        .get(nodeId) as Record<string, unknown> | undefined;
      if (!row) throw new SideraError("not_found", "Node not found");
      return { ...row, identityMetadata: JSON.parse(String(row.identityMetadata)),
        selfState: JSON.parse(String(row.selfState)) } as unknown as NodeRecord;
    });
  }

  retireNode(context: RegistryWriteContext, nodeId: string): NodeRecord {
    return this.write(context, "node.retire", this.resource(nodeId), () => {
      this.getNode(nodeId);
      this.db.prepare("UPDATE sessions SET state = 'retired' WHERE node_id = ?")
        .run(nodeId);
      this.db.prepare("UPDATE nodes SET lifecycle = 'retired' WHERE node_id = ?")
        .run(nodeId);
      return this.getNode(nodeId);
    });
  }

  async bindSession(context: RegistryWriteContext, input: BindSessionInput): Promise<SessionRecord> {
    // Snapshot caller-owned objects before awaiting host I/O.
    context = { ...context };
    input = { ...input };
    this.checkContext(context);
    this.requireActiveNode(input.nodeId);
    if (input.state !== undefined && input.state !== "active" && input.state !== "standby") {
      throw new SideraError("conflict", "New sessions must be active or standby");
    }
    await this.locate(input);
    return this.write(context, "session.bind", this.resource(input.nodeId), () => {
      this.requireActiveNode(input.nodeId);
      // Even retired bindings retain ownership: pinned historical work must not
      // silently acquire a different node's host conversation.
      const owner = this.db.prepare(`SELECT session_id FROM sessions
        WHERE hythe_id = ? AND locator_ref = ?`).get(input.hytheId, input.locatorRef);
      if (owner) throw new SideraError("conflict", "Locator already bound");
      const sessionId = randomUUID();
      this.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(sessionId, input.nodeId, input.hytheId, input.hostKind, input.locatorRef,
          input.state ?? "standby", new Date().toISOString());
      return this.getSession(sessionId);
    });
  }

  getSession(sessionId: string): SessionRecord {
    return this.read(() => {
      const row = this.db.prepare(`SELECT ${sessionColumns} FROM sessions WHERE session_id = ?`)
        .get(sessionId);
      if (!row) throw new SideraError("not_found", "Session not found");
      return row as unknown as SessionRecord;
    });
  }

  getActiveSession(nodeId: string): SessionRecord | null {
    this.getNode(nodeId);
    return this.read(() => (this.db.prepare(`SELECT ${sessionColumns} FROM sessions
      WHERE node_id = ? AND state = 'active'`).get(nodeId) as unknown as SessionRecord) ?? null);
  }

  /** expectedActiveSessionId provides compare-and-swap protection against stale
   * callers and races during asynchronous locator validation. null means no active.
   */
  async handoffSession(
    context: RegistryWriteContext,
    nodeId: string,
    nextSessionId: string,
    expectedActiveSessionId: string | null,
    commitWake?: () => void,
  ): Promise<SessionRecord> {
    context = { ...context };
    this.checkContext(context);
    this.requireActiveNode(nodeId);
    this.requireOwnedSession(nodeId, nextSessionId);
    await this.locate(this.getSession(nextSessionId));
    return this.write(context, "session.handoff", this.resource(nodeId), () => {
      this.requireActiveNode(nodeId);
      const next = this.requireOwnedSession(nodeId, nextSessionId);
      const active = this.getActiveSession(nodeId);
      if ((active?.sessionId ?? null) !== expectedActiveSessionId) {
        throw new SideraError("conflict", "Active session changed");
      }
      if (next.state !== "standby") {
        throw new SideraError("conflict", "Handoff target must be standby");
      }
      if (active) {
        this.db.prepare("UPDATE sessions SET state = 'retired' WHERE session_id = ?")
          .run(active.sessionId);
        // A Task returns to its origin Node, not to a disposable Host container.
        // Keep unfinished result routing attached to Node continuity when that
        // Node performs an authorized Session handoff. Completed/failed history
        // remains pinned to the historical Session for audit.
        const moving = this.db.prepare(`SELECT o.task_id FROM task_origins o JOIN tasks t USING(task_id)
          WHERE o.session_id=? AND t.origin_node_id=? AND t.state NOT IN ('completed','failed')`)
          .all(active.sessionId,nodeId) as {task_id:string}[];
        if(moving.length) {
          this.db.prepare(`UPDATE task_origins SET session_id=? WHERE session_id=? AND task_id IN
            (SELECT task_id FROM tasks WHERE origin_node_id=? AND state NOT IN ('completed','failed'))`)
            .run(nextSessionId,active.sessionId,nodeId);
          this.db.prepare("INSERT INTO events VALUES (?,?,'task.origin_session_handoff',?,?)")
            .run(randomUUID(),nodeId,JSON.stringify({previousSessionId:active.sessionId,nextSessionId,
              taskIds:moving.map(item=>item.task_id),replay:false}),new Date().toISOString());
        }
      }
      this.db.prepare("UPDATE sessions SET state = 'active' WHERE session_id = ?")
        .run(nextSessionId);
      // A prepared, unsent continuation moves atomically with this handoff.
      commitWake?.();
      return this.getSession(nextSessionId);
    }, { previousSessionId: expectedActiveSessionId });
  }

  closeSession(context: RegistryWriteContext, nodeId: string, sessionId: string): SessionRecord {
    return this.write(context, "session.close", this.resource(nodeId), () => {
      this.requireOwnedSession(nodeId, sessionId);
      this.db.prepare("UPDATE sessions SET state = 'retired' WHERE session_id = ?").run(sessionId);
      return this.getSession(sessionId);
    });
  }

  private requireActiveNode(nodeId: string): void {
    if (this.getNode(nodeId).lifecycle !== "active") {
      throw new SideraError("conflict", "Node is retired");
    }
  }

  private requireOwnedSession(nodeId: string, sessionId: string): SessionRecord {
    this.getNode(nodeId);
    const session = this.getSession(sessionId);
    if (session.nodeId !== nodeId) throw new SideraError("conflict", "Session belongs to another node");
    return session;
  }

  private async locate(input: Pick<SessionRecord, "hytheId" | "hostKind" | "locatorRef">): Promise<void> {
    this.nonempty(input.hytheId, "hytheId");
    this.nonempty(input.hostKind, "hostKind");
    this.nonempty(input.locatorRef, "locatorRef");
    try {
      const hythe = this.dependencies.getHythe(input.hytheId);
      if (!hythe) throw new SideraError("unavailable", "Hythe unavailable");
      if (hythe.hytheId !== input.hytheId || hythe.hostKind !== input.hostKind) {
        throw new SideraError("conflict", "Hythe identity or host kind mismatch");
      }
      if (await hythe.locate(input.locatorRef) !== true) {
        throw new SideraError("not_found", "Host session locator not found");
      }
    } catch (error) {
      if (error instanceof SideraError) throw error;
      throw new SideraError("unavailable", "Host session lookup unavailable");
    }
  }

  private resource(nodeId: string): string {
    this.nonempty(nodeId, "nodeId");
    return `node/${nodeId}`;
  }

  private nonempty(value: string, field: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new SideraError("conflict", `${field} must be nonempty`);
    }
  }

  private checkContext(context: RegistryWriteContext): void {
    this.nonempty(context.actorNodeId, "actorNodeId");
    this.nonempty(context.requestId, "requestId");
    this.nonempty(context.resourceScope, "resourceScope");
  }

  private write<T>(context: RegistryWriteContext, capability: RegistryCapability, resource: string,
    mutation: () => T, details: Record<string, unknown> = {}): T {
    this.checkContext(context);
    // Savepoints compose with a caller's task transaction and roll back partial
    // handoffs, including failure after retiring the previous active session.
    const savepoint = `registry_${randomUUID().replaceAll("-", "")}`;
    let opened = false;
    try {
      this.db.exec(`SAVEPOINT ${savepoint}`);
      opened = true;
      const authorization = this.dependencies.authorize({ ...context, capability, resource });
      if (authorization === false) {
        throw new SideraError("denied", "Registry action denied");
      }
      const result = mutation();
      if (authorization !== true && authorization.reservationId) {
        settleReservation(this.db, authorization.reservationId, "consumed");
      }
      this.db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)").run(randomUUID(),this.db.prepare("SELECT 1 FROM nodes WHERE node_id=?").get(context.actorNodeId)?context.actorNodeId:null,
        capability,JSON.stringify({requestId:context.requestId,actorRef:context.actorNodeId,resource,result,...details}),new Date().toISOString());
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      opened = false;
      return result;
    } catch (error) {
      if (opened) {
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          throw new SideraError("uncertain", "Registry rollback could not be confirmed");
        }
      }
      throw this.normalizeError(error);
    }
  }

  private read<T>(query: () => T): T {
    try { return query(); } catch (error) { throw this.normalizeError(error); }
  }

  private normalizeError(error: unknown): SideraError {
    if (error instanceof SideraError) return error;
    const code = (error as { errcode?: number } | null)?.errcode;
    // SQLite extended result codes retain the primary code in the low byte.
    if (typeof code === "number" && (code & 0xff) === 19) {
      return new SideraError("conflict", "Registry constraint conflict");
    }
    return new SideraError("unavailable", "Registry storage or authorization unavailable");
  }
}

/** Use as Registry.authorize only after RPC has authenticated the caller Session. */
export function registryAuthority(db: DatabaseSync): RegistryDependencies["authorize"] {
  return input => {
    if (!input.actorSessionId) {
      throw new SideraError("denied", "Registry write requires an authenticated Session");
    }
    const own = input.resource === `node/${input.actorNodeId}`;
    return reserveCapability(db, {
      subjectNodeId: input.actorNodeId,
      sessionId: input.actorSessionId,
      capability: own ? `self.${input.capability}` : input.capability,
      resource: input.resource,
      requestId: input.requestId,
    });
  };
}
