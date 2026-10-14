import { packageDigest, preparePermissionPackage, type PermissionPackageItem,
  type PermissionPackageManifest } from "./permission-package.ts";
import { SideraError } from "./types.ts";

export type DevelopmentProfileMode = "read-only" | "workspace" | "full-access";
export interface DevelopmentWorkspaceScope {
  /** Canonical Authority resource, not an arbitrary filesystem path. */
  resourceScope: string;
  access: "read" | "write";
  kind: "fixture" | "production";
}
export interface DevelopmentProfileSubject {
  nodeId: string;
  collaboratorNodeIds: string[];
  workspaces: DevelopmentWorkspaceScope[];
  /** A fixture-only Node is expressed by policy, never by its brand or name. */
  productionWorkspaceAccess?: "none" | "read" | "write";
}
export interface DevelopmentProfileInput {
  worldId: string;
  packageId: string;
  revision?: number;
  mode: DevelopmentProfileMode;
  subjects: DevelopmentProfileSubject[];
  /** Individually described high-privilege scopes, reviewed in the same package. */
  fullAccessItems?: PermissionPackageItem[];
  /** Nodes configured as the built-in contained executor. They may run the
   * bundled Node executable only inside their own Core-owned Peregrine
   * workspace; this is not a general host-tool or filesystem grant. */
  containedWorkspaceNodeIds?: string[];
  expiresAt?: string | null;
}
export interface DevelopmentProfilePlan {
  mode: DevelopmentProfileMode;
  manifest: PermissionPackageManifest;
  digest: string;
  admission: {
    method: "existing-human-permission-package";
    required: true;
    fullAccessConfirmationRequired: boolean;
    ordinaryActionsWithinAdmittedScopeNeedNewGrant: false;
  };
  limits: string[];
}

const inspectionOperations = ["node.inspect", "node.capabilities", "session.list", "session.inspect",
  "model.inspect", "model.list", "host.inspect", "host.status", "conversation.read", "conversation.observe", "tool.list"];
// Concrete capabilities prevent Normal from silently gaining newly introduced
// account/payment/Host-admin operations through a broad self.* wildcard.
const ownWorkCapabilities = ["self.subjectivity.write", "self.responsibility.create", "self.responsibility.accept",
  "self.responsibility.complete", "self.escalate", "self.supervision.open", "self.task.reconcile",
  "self.frontend.receive", "self.artifact.register", "self.task.resume", "self.host.execute", "self.model.bind", "self.model.migrate", "self.session.bind", "self.session.handoff",
  "self.session.close", "self.session.create", "self.peregrine.create"];
const cooperationCapabilities = ["task.dispatch", "message.send", "responsibility.create", "responsibility.transfer"];

function identifier(value: string, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value))
    throw new SideraError("conflict", `${field} must be an exact identifier`);
  return value;
}
function workspaceScope(value: string, nodeId: string): string {
  // Host-scoped execution and another Node's sovereign domain are not workspace
  // permission. Broad machine access belongs in an explicit Full Access item.
  if (typeof value !== "string" || value.includes("\\") || value.split("/").some(p => p === "." || p === "..") ||
    !/^(?:project\/[^/*]+\/(?:workspace|source)(?:\/[^/*]+)*|node\/[^/*]+\/workspace)(?:\/\*\*)?$/.test(value))
    throw new SideraError("conflict", "Workspace must name a bounded project or owned workspace resource");
  if (value.startsWith("node/") && !value.startsWith(`node/${nodeId}/workspace`))
    throw new SideraError("denied", "A workspace profile cannot grant another Node's sovereign workspace");
  return value;
}

/**
 * Pure policy expansion. This function opens no database and establishes no
 * Authority. A CLI may display this plan, then use packageActArgs -> trusted
 * Human ingress/admission -> applyPermissionPackage -> materializePermissionPackage.
 * Reusing an already admitted exact package is idempotent; changing its scopes
 * requires a newly admitted revision. Full Access never self-admits.
 *
 * These are Sidera grants, not an OS sandbox or a substitute for a Host's own
 * execution/disclosure controls. Workspace paths must come from Human-owned config.
 */
export function planDevelopmentProfile(input: DevelopmentProfileInput): DevelopmentProfilePlan {
  if (!["read-only", "workspace", "full-access"].includes(input.mode))
    throw new SideraError("conflict", "Unknown development permission profile");
  identifier(input.worldId, "worldId"); identifier(input.packageId, "packageId");
  if (!input.subjects.length || new Set(input.subjects.map(s => s.nodeId)).size !== input.subjects.length)
    throw new SideraError("conflict", "Profile subjects must be nonempty and unique");
  if (input.fullAccessItems?.length && input.mode !== "full-access")
    throw new SideraError("denied", "Additional high-privilege scopes require Full Access review");
  if (input.expiresAt != null && !Number.isFinite(Date.parse(input.expiresAt)))
    throw new SideraError("conflict", "Profile expiration must be a valid timestamp");
  const items: PermissionPackageItem[] = [];
  const add = (nodeId: string, capability: string, resourceScope: string, purpose: string) => {
    items.push({ purpose, grant: { requestId: "planned", subjectNodeId: nodeId, capability, resourceScope,
      delegable: false, productScope: "*", effectScope: "admission", disclosureScope: "handoff_bounded",
      expiresAt: input.expiresAt ?? null } });
  };
  for (const subject of [...input.subjects].sort((a, b) => a.nodeId.localeCompare(b.nodeId))) {
    const nodeId = identifier(subject.nodeId, "nodeId"), own = `node/${nodeId}/**`;
    const production = subject.productionWorkspaceAccess ?? "none";
    if (!["none", "read", "write"].includes(production)) throw new SideraError("conflict", "Invalid production workspace policy");
    for (const operation of inspectionOperations) {
      add(nodeId, `self.${operation}`, own, `Inspect own ${operation}`);
      // host_control and capability_invoke have distinct authorization names.
      add(nodeId, `self.host.${operation}`, own, `Inspect own Host ${operation}`);
    }
    for (const target of [...new Set(subject.collaboratorNodeIds)].sort()) {
      identifier(target, "collaboratorNodeId");
      for (const operation of inspectionOperations.filter(o => !o.startsWith("conversation.")))
        add(nodeId, `${target === nodeId ? "self." : ""}${operation}`, `node/${target}/**`, `Inspect declared collaborator ${target}`);
      if (input.mode !== "read-only")
        for (const capability of cooperationCapabilities)
          add(nodeId, capability, `node/${target}`, `Cooperate with declared Node ${target}`);
    }
    if (input.mode !== "read-only") {
      for (const capability of ownWorkCapabilities) add(nodeId, capability, own, "Manage own work and runtime identity");
      // A Node can complete self-targeted work and send results to itself.
      for (const capability of ["task.dispatch", "message.send"])
        add(nodeId, capability, `node/${nodeId}`, "Operate own task and result surface");
      if ((input.containedWorkspaceNodeIds ?? []).includes(nodeId)) {
        // The built-in executor runs one bounded script with the bundled Node
        // executable inside its own contained workspace. The scope is the
        // Core-owned Peregrine domain only; no user path and no other program.
        add(nodeId, "self.peregrine.run", `node/${nodeId}/peregrine/**`,
          "Run one bounded script inside the built-in contained executor workspace");
      }
    }
    for (const workspace of subject.workspaces) {
      const scope = workspaceScope(workspace.resourceScope, nodeId);
      if (!["read", "write"].includes(workspace.access) || !["fixture", "production"].includes(workspace.kind))
        throw new SideraError("conflict", "Workspace access and kind must be explicit");
      if (workspace.kind === "production" && (production === "none" || workspace.access === "write" && production !== "write"))
        throw new SideraError("denied", "Workspace exceeds this Node's production resource policy");
      const ownWorkspace = scope.startsWith("node/");
      const source = scope.startsWith("project/") && scope.split("/")[2] === "source";
      const prefix = ownWorkspace ? "self.workspace" : source ? "project.source" : "project.workspace";
      add(nodeId, `${prefix}.read`, scope, `Read declared ${workspace.kind} workspace`);
      if (workspace.access === "write" && input.mode !== "read-only")
        add(nodeId, `${prefix}.write`, scope, `Modify declared ${workspace.kind} workspace`);
    }
  }
  for (const item of input.fullAccessItems ?? []) {
    if (!input.subjects.some(s => s.nodeId === item.grant.subjectNodeId))
      throw new SideraError("denied", "Full Access item subject is outside this profile");
    items.push({ purpose: `Full Access: ${item.purpose}`, grant: { ...item.grant, delegable: false } });
  }
  // Stable sorting/deduplication keeps declarative config order out of approval
  // identity. Package revision and changed scope still change the reviewed digest.
  const key = (item: PermissionPackageItem) => JSON.stringify({ ...item.grant, requestId: undefined });
  const unique = [...new Map(items.map(item => [key(item), item])).entries()]
    .sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item);
  const manifest = preparePermissionPackage({ worldId: input.worldId, packageId: input.packageId,
    revision: input.revision, label: `Development ${input.mode}`, items: unique });
  return { mode: input.mode, manifest, digest: packageDigest(manifest), admission: {
    method: "existing-human-permission-package", required: true,
    fullAccessConfirmationRequired: input.mode === "full-access", ordinaryActionsWithinAdmittedScopeNeedNewGrant: false,
  }, limits: ["Planning does not grant Authority; exact Human-rooted package admission remains required.",
    "Existing grants and Human constraints remain effective; this plan does not revoke broader previous access.",
    "Workspace mode adds no payment, subscription, account-admin or arbitrary Host-tool capability.",
    input.containedWorkspaceNodeIds?.length ? "The built-in contained executor may run the bundled Node executable only inside its own Core-owned workspace." : "",
    "Host execution and disclosure controls still apply; this profile is not an OS sandbox."] };
}
