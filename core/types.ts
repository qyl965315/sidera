export type NodeId = string;
export type SessionId = string;
export type TaskId = string;
export type MessageId = string;

export interface NodeRecord {
  nodeId: NodeId;
  displayName: string;
  lifecycle: "active" | "retired";
  createdAt: string;
  identityMetadata: Record<string, unknown>;
  /** @deprecated Legacy local configuration; canonical Sovereign Memory is D + Exp. */
  selfState: Record<string, unknown>;
  activeSelfHead: string;
  lineageRef: string;
}

export interface ModelBindingRecord {
  bindingId: string;
  nodeId: NodeId;
  provider: string;
  modelId: string;
  reasoningConfig: Record<string, unknown>;
  validFrom: string;
  validUntil: string | null;
  migrationFrom: string | null;
}

export interface SessionRecord {
  sessionId: SessionId;
  nodeId: NodeId;
  hytheId: string;
  hostKind: string;
  locatorRef: string;
  state: "active" | "standby" | "retired";
  createdAt: string;
}

export interface GrantRecord {
  grantId: string;
  subjectNodeId: NodeId;
  capability: string;
  resourceScope: string;
  issuer: string;
  expiresAt: string | null;
  limit: number | null;
  riskCeiling: number | null;
  delegable: boolean;
  parentGrantId: string | null;
  revokedAt: string | null;
  validFrom?: string | null;
  worldId?: string | null;
  projectRef?: string | null;
  taskRef?: string | null;
  modelScope?: string[] | null;
  maxDelegationDepth?: number | null;
}

export type SideraErrorCode =
  | "denied"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "uncertain";

export class SideraError extends Error {
  readonly code: SideraErrorCode;
  constructor(code: SideraErrorCode, message: string) {
    super(message);
    this.name = "SideraError";
    this.code = code;
  }
}
