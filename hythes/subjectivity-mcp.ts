import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callCore, type CoreClientConfig } from "./core-client.ts";

export function registerSubjectivityControl(server: McpServer, core: CoreClientConfig): void {
  const invoke = async (method: string, input: Record<string, unknown>) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await callCore(core, method, input)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Inspect before another action" }] }; }
  };
  const ref = z.object({ kind: z.enum(["responsibility","task","message","event","dependency","subjectivity"]), id: z.string().min(1).max(200) });
  server.registerTool("project_source_read", {
    description: "Read a bounded range of authorized Sidera integration source/docs. Paths: root uppercase .md documents, core/hythes/peregrine/qwen/scripts/tests .ts or .md files (including .test.ts), or scripts .ps1 files. Runtime profiles and credentials are excluded; Core checks project.source.read Grant. Another Node's workspace artifact is not a repository-root file.",
    inputSchema: { requestId:z.string().uuid(), path:z.string().min(1), startLine:z.number().int().positive().optional(), lineCount:z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint:true,openWorldHint:false },
  }, input => invoke("project.source_read",input));
  server.registerTool("tension_list", {
    description: "Inspect your own persistent tensions. Core derives commitment tension from accepted Responsibilities; other tensions are your interpretation.",
    inputSchema: { actionableOnly: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, input => invoke("tension.list", input));
  server.registerTool("tension_register", {
    description: "Author a subjective, evidence or coordination tension in your own domain. References are provenance, not proof. Core alone creates commitment tensions.",
    inputSchema: { requestId: z.string().uuid(), kind: z.enum(["subjective","evidence","coordination"]),
      statement: z.string().min(1).max(8000), sourceRefs: z.array(ref).max(32).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, input => invoke("tension.register", input));
  server.registerTool("tension_update", {
    description: "Revise your tension statement/status. An active accepted public commitment cannot be resolved, hidden or relinquished through this tool; complete/transfer the Responsibility publicly.",
    inputSchema: { requestId: z.string().uuid(), tensionId: z.string().min(1),
      statement: z.string().min(1).max(8000).optional(), sourceRefs: z.array(ref).max(32).optional(),
      status: z.enum(["open","waiting","resolved","relinquished","escalated"]).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, input => invoke("tension.update", input));
  server.registerTool("runtime_checkpoint", {
    description: "Explicit bounded lifecycle outcome. WAIT requires an already submitted child dependency and stops inference after you end the turn. CONTINUE needs an actionable own tension plus new observed event/subjectivity revision; at most two immediate continuations per Task. IDLE finishes this wake. Never poll for child results.",
    inputSchema: { requestId: z.string().uuid(), runId: z.string().min(1),
      outcome: z.enum(["CONTINUE","WAIT","IDLE"]), tensionId: z.string().min(1).optional(),
      checkpoint: z.string().min(1).max(8000), progressRefs: z.array(ref).max(8).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, input => invoke("runtime.checkpoint", input));
  server.registerTool("history_event_get", {
    description: "Inspect one exact Shared History event addressed to you or authored by you. Evidence may differ from your current Description; decide whether to revise it yourself.",
    inputSchema: { eventId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ eventId }) => {
    try { return { content: [{ type: "text" as const,
      text: JSON.stringify(await callCore(core, "history.event_get", { eventId })) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const,
      text: error instanceof Error ? error.message : "Event read failed" }] }; }
  });
  server.registerTool("subjectivity_get", {
    description: "Read your own current Description and Explanation. They are subjective, not Shared History facts.",
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try { return { content: [{ type: "text" as const,
      text: JSON.stringify(await callCore(core, "subjectivity.get", {})) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const,
      text: error instanceof Error ? error.message : "Subjectivity read failed" }] }; }
  });
  server.registerTool("subjectivity_revise", {
    description: "Atomically author your next Description and Explanation. Keep impressions distinct from evidence. Supply the current revision and a fresh requestId; if the result is uncertain, inspect before another write.",
    inputSchema: z.strictObject({ requestId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(),
      description: z.string().max(100_000), explanation: z.string().max(100_000) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async input => {
    try { return { content: [{ type: "text" as const,
      text: JSON.stringify(await callCore(core, "subjectivity.revise", input)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const,
      text: error instanceof Error ? error.message : "uncertain: inspect before another revision" }] }; }
  });
}
