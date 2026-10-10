import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callCore, type CoreClientConfig } from "./core-client.ts";

/** One shared organizational surface for every authenticated Node Host. */
export function registerOrganizationControl(server: McpServer, core: CoreClientConfig): void {
  server.registerTool("responsibility_accept", {
    description: "Accept a proposed Responsibility addressed to you. A proposal is not yet a public commitment. Acceptance creates its Rule-derived commitment tension.",
    inputSchema: { requestId: z.string().uuid(), responsibilityId: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async input => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await callCore(core, "responsibility.accept", input)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Inspect before accepting again" }] }; }
  });
  const invoke = async (method: string, input: Record<string, unknown>) => {
    try {
      const result = await callCore(core, method, input) as Record<string, unknown>;
      return { isError: result.state === "BLOCKED", content: [{ type: "text" as const,
        text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const,
        text: error instanceof Error ? error.message : "uncertain: reconcile without resending" }] };
    }
  };

  server.registerTool("role_appoint", {
    description: "Appoint a Node to a task-scoped organizational role. A role is a duty, never Node identity. Core Authority decides whether the caller may appoint it.",
    inputSchema: { requestId: z.string().uuid(), subjectNodeId: z.string().min(1),
      role: z.string().min(1), scope: z.string().min(1).optional(),
      expiresAt: z.string().datetime().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, input => invoke("role.appoint", input));

  server.registerTool("responsibility_defer", {
    description: "Publicly defer a pending Responsibility. Requires explicit cross-subject Authority; self.* does not permit this. The accepted commitment remains as waiting.",
    inputSchema: { requestId: z.string().uuid(), responsibilityId: z.string().uuid(), reason: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, input => invoke("responsibility.defer", input));
  server.registerTool("escalation_defer", {
    description: "Append a deferred disposition to an escalation. Requires Authority and grants no capability; neither approval nor denial.",
    inputSchema: { requestId: z.string().uuid(), escalationId: z.string().uuid(), reason: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, input => invoke("escalation.defer", input));

  server.registerTool("role_list", {
    description: "Read this authenticated Node's current organizational role appointments. Roles are duties, not identity or permissions.",
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
  }, input => invoke("role.list", input));

  server.registerTool("responsibility_create", {
    description: "Create a durable responsibility with one owner Node. Chief checks frontend binding, transport and authorized target before creation. BLOCKED creates no Responsibility; report that state, never ask Human to copy prompts. Shared History is a world archive, not Agent Memory.",
    inputSchema: { requestId: z.string().uuid(), title: z.string().min(1),
      scope: z.string().min(1), ownerNodeId: z.string().min(1),
      basis:z.object({intentRevisionId:z.string().uuid(),contextBasis:z.array(z.string().min(1)).min(1)}).optional(),
      parentResponsibilityId: z.string().uuid().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, input => invoke("responsibility.create", { ...input, frontendConversationRef: core.chiefConversationRef }));

  server.registerTool("responsibility_get", {
    description: "Read one responsibility visible to this Node, including its current owner and state.",
    inputSchema: { responsibilityId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, input => invoke("responsibility.get", input));

  server.registerTool("responsibility_list", {
    description: "List durable responsibilities currently owned by this Node.",
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
  }, input => invoke("responsibility.list", input));

  server.registerTool("responsibility_transfer", {
    description: "Transfer ownership of one durable responsibility. Core checks Authority and records the handoff event.",
    inputSchema: { requestId: z.string().uuid(), responsibilityId: z.string().uuid(),
      nextOwnerNodeId: z.string().min(1), expectedOwnerNodeId: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, input => invoke("responsibility.transfer", input));

  server.registerTool("responsibility_complete", {
    description: "Mark a responsibility completed after its owner has accepted the result. Core records the completion event.",
    inputSchema: { requestId: z.string().uuid(), responsibilityId: z.string().uuid(),
      expectedOwnerNodeId: z.string().min(1), closureBasis:z.object({kind:z.literal("supervision-accept"),supervisionId:z.string().uuid(),roundIndex:z.number().int().min(1)}) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, input => invoke("responsibility.complete", input));

  server.registerTool("grant_delegate", {
    description: "Delegate a subset of one of your delegable Grants to another Node. All ancestor boundaries remain binding. Omitted dimensions inherit parent restrictions; explicit null cannot widen a bounded parent. Core checks World, Project, Task, ModelBinding, time, budget and delegability.",
    inputSchema: { requestId: z.string().uuid(), parentGrantId: z.string().uuid(),
      subjectNodeId: z.string().min(1), capability: z.string().min(1),
      resourceScope: z.string().min(1), limit: z.number().int().positive().nullable().optional(),
      expiresAt: z.string().datetime().nullable().optional(), delegable: z.boolean().optional(),
      riskCeiling: z.number().int().min(0).max(3).nullable().optional(),
      validFrom:z.string().datetime().nullable().optional(),worldId:z.string().min(1).optional(),
      projectRef:z.string().min(1).nullable().optional(),taskRef:z.string().uuid().nullable().optional(),
      modelScope:z.array(z.string().min(1)).min(1).nullable().optional(),maxDelegationDepth:z.number().int().min(0).nullable().optional(),
      productScope:z.string().min(1).optional(),effectScope:z.enum(["admission","post_admission_revocable"]).optional(),
      disclosureScope:z.string().min(1).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, input => invoke("grant.delegate", input));

  server.registerTool("grant_list", {
    description: "List this authenticated Node's own Grants and parentGrantIds so it can choose a delegable parent. This does not grant authority.",
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
  }, input => invoke("grant.list", input));

  server.registerTool("escalation_raise", {
    description: "Record a blocker for the next responsible Supervisor. Routine bugs and worker changes should be handled locally.",
    inputSchema: { requestId: z.string().uuid(), reason: z.string().min(1),
      details: z.string().min(1), responsibilityId: z.string().uuid().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, input => invoke("escalation.raise", input));
}
