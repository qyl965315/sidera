import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { callCore, type CoreClientConfig } from "./core-client.ts";

/**
 * Resource / Artifact machine surface.
 *
 * This is the file, attachment and result boundary of the Work Plane. It exists
 * so a Human attachment and a Node-produced artifact travel the same durable
 * path, and so no participant has to copy a filesystem path by hand.
 *
 * Bytes are content-addressed and world-scoped in Core; this surface only
 * carries them. Nothing here creates or widens Authority.
 */
export function registerResourceControl(server: McpServer, core: CoreClientConfig): void {
  const invoke = async (method: string, params: Record<string, unknown>) =>
    ({ content: [{ type: "text" as const, text: JSON.stringify(await callCore(core, method, params)) }] });

  server.registerTool("resource_put", {
    description: "Publish bytes or literal text as a durable, content-addressed Sidera Resource. "
      + "Provide exactly one of dataBase64 or dataText. Core records digest, size, origin and provenance; "
      + "world scope and the caller's own Human-rooted grant are still enforced.",
    inputSchema: { requestId: z.string().uuid(), name: z.string().min(1).max(300),
      mediaType: z.string().min(1).max(200).optional(),
      origin: z.enum(["human", "node", "host", "local-operator"]).optional(),
      sourceRef: z.string().min(1).max(2000).optional(),
      taskId: z.string().uuid().optional(), runId: z.string().uuid().optional(),
      artifactId: z.string().uuid().optional(),
      dataBase64: z.string().min(1).optional(), dataText: z.string().min(1).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, input => invoke("resource.put", input));

  server.registerTool("resource_metadata", {
    description: "Read a Resource's metadata and provenance without transferring its bytes.",
    inputSchema: { resourceId: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, input => invoke("resource.metadata", input));

  server.registerTool("resource_get", {
    description: "Read a Resource's bytes. Text is returned as UTF-8; set asBase64 for binary. "
      + "A Resource outside this subject's scope is denied, not silently empty.",
    inputSchema: { resourceId: z.string().uuid(), asBase64: z.boolean().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, input => invoke("resource.get", input));

  server.registerTool("resource_list", {
    description: "List Resources visible to this subject, optionally filtered by Task or Run. "
      + "Existence does not imply visibility.",
    inputSchema: { taskId: z.string().uuid().optional(), runId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, input => invoke("resource.list", input));

  server.registerTool("resource_scope", {
    description: "Scope a Resource to another Node as the explicit basis for a later authorized read. "
      + "Scoping grants no capability: the reading Node still needs its own Human-rooted grant.",
    inputSchema: { requestId: z.string().uuid(), resourceId: z.string().uuid(),
      targetNodeId: z.string().min(1), basis: z.string().min(1).max(1000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, input => invoke("resource.scope", input));
}
