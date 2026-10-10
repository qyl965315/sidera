import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callCore,type CoreClientConfig } from "./core-client.ts";
export function registerWorkspaceControl(server:McpServer,core:CoreClientConfig):void {
server.registerTool("workspace_write_text", {
  description: "Create or replace one text file in your own Peregrine workspace through Core self.workspace.write authority. Use a simple file name such as BILATERAL_R1_E2E.md. For replace, provide the exact previous content as expectedContent. The result contains the verified absolute path. If uncertain, reconcile this request ID and do not resend.",
  inputSchema: { requestId: z.string().uuid(), fileName: z.string().min(1).max(100),
    content: z.string().min(1).max(500_000), mode: z.enum(["create", "replace"]).optional(),
    expectedContent: z.string().min(1).max(500_000).optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async input => {
  try { return { content: [{ type: "text" as const,
    text: JSON.stringify(await callCore(core, "peregrine.write_text", input)) }] }; }
  catch (error) { return { isError: true, content: [{ type: "text" as const,
    text: error instanceof Error ? error.message : "uncertain: do not resend" }] }; }
});
server.registerTool("workspace_read_text", {
  description: "Read one simple-name text file from your own Peregrine workspace through Core self.workspace.read authority. This cannot read another Node's domain or an arbitrary absolute path.",
  inputSchema: { fileName: z.string().min(1).max(100) },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ fileName }) => {
  try { return { content: [{ type: "text" as const,
    text: JSON.stringify(await callCore(core, "peregrine.read_text", { fileName })) }] }; }
  catch (error) { return { isError: true, content: [{ type: "text" as const,
    text: error instanceof Error ? error.message : "Workspace read failed" }] }; }
});
server.registerTool("write_e2e_marker", {
  description: "For your Sidera E2E task only: create SIDERA_E2E_OK.txt inside an owned Peregrine through Core Authority and return the verified absolute path. Supply the Sidera message ID from the task envelope. Do not substitute a shell command. An uncertain result must not be retried.",
  inputSchema: { messageId: z.string().uuid() },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ messageId }) => {
  const response = await callCore(core,"peregrine.write_e2e_marker",{messageId}) as Record<string,unknown>;
  return { isError: Boolean(response.error), content: [{ type: "text" as const,
    text: JSON.stringify(response.error ?? response.result) }] };
});
}
