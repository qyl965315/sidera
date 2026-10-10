import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callCore, getReadView, getTaskView, type CoreClientConfig } from "./core-client.ts";

/** The same control vocabulary is available to either authenticated Node. */
export function registerHostControl(server: McpServer, core: CoreClientConfig): void {
  server.registerTool("message_reconcile_result",{description:"Read an original standalone delivery/review Host turn by exact message ID. Requires the original receiving Session and self.task.reconcile. Never starts inference or resends. Interrupted turn closes occupancy but does not become a completed result.",inputSchema:{requestId:z.string().uuid(),messageId:z.string().uuid()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},async input=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"message.reconcile_result",input))}]}));
  server.registerTool("task_reconcile_result",{description:"Reconcile one exact Task Run result from its original executing Session. Reads correlated Host completion evidence only; never starts inference, resends a message or replays an uncertain Effect.",inputSchema:{requestId:z.string().uuid(),runId:z.string().uuid()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},async input=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"task.reconcile_result",input))}]}));
  const sources=z.array(z.object({kind:z.enum(["artifact","message"]),id:z.string().min(1)})).min(1).max(16);
  const contextInput={requestId:z.string().uuid(),targetNodeId:z.string().min(1),basis:z.object({responsibilityId:z.string().uuid(),intentRevisionId:z.string().uuid(),contextBasis:z.array(z.string().min(1)).min(1)}),purpose:z.string().min(1),selector:z.string().min(1),sourceRefs:sources,disclosureGrantId:z.string().optional()};
  const invoke=(method:string,input:unknown)=>callCore(core,method,input as Record<string,unknown>).then(value=>({content:[{type:"text" as const,text:JSON.stringify(value)}]}));
  server.registerTool("node_create",{description:"Register a new independent Node in your World using explicit Authority. Does not create a Host or Human Chat.",inputSchema:{requestId:z.string().uuid(),displayName:z.string().min(1)},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},input=>invoke("node.create",input));
  server.registerTool("node_retire",{description:"Retire an exact Node and its Session resources under explicit Authority; retain history and fence pending work. Does not kill a user's Host.",inputSchema:{requestId:z.string().uuid(),nodeId:z.string().min(1)},annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}},input=>invoke("node.retire",input));
  server.registerTool("artifact_get",{description:"Read a Task-participant ArtifactReference and immutable provenance. Does not fetch remote bytes.",inputSchema:{artifactId:z.string().uuid()},annotations:{readOnlyHint:true,openWorldHint:false}},input=>invoke("artifact.get",input));
  server.registerTool("artifact_register",{description:"Register an immutable artifact reference and Task/Run provenance. Accessibility is an attributed claim, never proof of bytes. No upload or filesystem read.",inputSchema:{requestId:z.string().uuid(),taskId:z.string().uuid(),runId:z.string().uuid().optional(),reference:z.string().min(1),versionRef:z.string().optional(),title:z.string().optional(),sourceRefs:sources.optional(),accessibility:z.object({status:z.enum(["AVAILABLE","UNAVAILABLE","UNKNOWN"]),sourceRef:z.string().optional()}).optional()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},input=>invoke("artifact.register",input));
  server.registerTool("context_preview",{description:"Preview exact selected context/disclosure envelope. Read-only; CanAct is not CanDisclose. Existing broad UNKNOWN scopes cannot disclose it.",inputSchema:contextInput,annotations:{readOnlyHint:true,openWorldHint:false}},input=>invoke("context.preview",input));
  server.registerTool("context_handoff",{description:"Create exact selected Context Handoff, and send only if a separate effective Human-rooted disclosure scope covers its exact envelope. No Memory copying, no inferred disclosure grants, uncertain never retries.",inputSchema:contextInput,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},input=>invoke("context.handoff",input));
  server.registerTool("context_get",{description:"Read created/delivered/observed stages from canonical message ACK; does not imply understanding or completion.",inputSchema:{handoffId:z.string().uuid()},annotations:{readOnlyHint:true,openWorldHint:false}},input=>invoke("context.get",input));
  server.registerTool("cooperation_start",{description:"Wake your own Supervisor execution Session for a goal within an already accepted Responsibility/Intent. The real Node selects workers and reviewers. Durable intent; uncertain is never replayed.",inputSchema:{requestId:z.string().uuid(),goal:z.string().min(1).max(16000),basis:z.object({responsibilityId:z.string().uuid().optional(),intentRevisionId:z.string().uuid(),contextBasis:z.array(z.string().min(1)).min(1)})},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},async input=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"cooperation.start",input))}]}));
  server.registerTool("world_inspect",{description:"Read public Nodes and your work in the current World; no private memory or credentials.",inputSchema:{limit:z.number().int().min(1).max(200).optional()},annotations:{readOnlyHint:true,openWorldHint:false}},async input=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"world.inspect",input))}]}));
  server.registerTool("work_inspect",{description:"Inspect one Task, Responsibility or Supervision with canonical provenance, rounds and delivery state. Participant access enforced.",inputSchema:{taskId:z.string().uuid().optional(),responsibilityId:z.string().uuid().optional(),supervisionId:z.string().uuid().optional()},annotations:{readOnlyHint:true,openWorldHint:false}},async input=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"work.inspect",input))}]}));
  server.registerTool("runtime_status",{description:"Read the loaded Core build identity captured at startup and current activation. Disk HEAD is not loaded code.",inputSchema:{},annotations:{readOnlyHint:true,openWorldHint:false}},
    async()=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"runtime.status",{}))}]}));
  server.registerTool("chief_frontend_prepare",{description:"Explicit browser-free route recovery: authenticate the exact current Primary Chat using native/protocol read, record sourced Presence and prepare a declared route. No UI fallback or new Chat.",inputSchema:{},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},
    async()=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"chief.frontend_prepare",{}))}]}));
  server.registerTool("supervision_open",{description:"A Node opens its own durable supervision with falsifiable acceptance criteria and a bounded round budget. Supply supervisionId on its task_dispatch. Duplicate requestId is idempotent.",
    inputSchema:{requestId:z.string().uuid(),responsibilityId:z.string().uuid().optional(),goal:z.string().min(1),acceptanceCriteria:z.string().min(1),maxRounds:z.number().int().min(1).max(50)},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
    async input=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"supervision.open",input))}]}));
  server.registerTool("supervision_view",{description:"Read your existing supervision, rounds and decisions. Does not advance it.",inputSchema:{supervisionId:z.string().uuid()},annotations:{readOnlyHint:true,openWorldHint:false}},
    async input=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"supervision.view",input))}]}));
  server.registerTool("chief_presentation_observe",{description:"Read the exact original Chat to reconcile a presentation marker. Never resends; visible presentation does not imply Human attention.",inputSchema:{messageId:z.string().uuid()},annotations:{readOnlyHint:true,openWorldHint:false}},
    async input=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"chief.presentation_observe",input))}]}));
  server.registerTool("chief_presentation_correct",{description:"For a legacy accepted presentation containing a stale Worker draft, publish the already-recorded terminal Supervisor decision once. Requires original presentation actually observed, current frontend Authority and final Effect gate. Never reruns Tasks or retries uncertain sends.",inputSchema:{supervisionId:z.string().uuid()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},
    async input=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"chief.presentation_correct",input))}]}));
  server.registerTool("supervision_decide",{description:"Accountable Supervisor decides one completed round: CONTINUE/REWORK/RECONCILE with self-contained instruction generates next work via events; WAIT names a relevant event kind; STOP ends; only ACCEPT/ESCALATE present to Human. For ACCEPT/ESCALATE, reason is the self-contained final Human summary, using post-completion evidence rather than a Worker in-flight snapshot. Choose nextNodeId to change worker/reviewer; omitted keeps the previous worker. Never manually duplicate the next dispatch.",
    inputSchema:{supervisionId:z.string().uuid(),roundIndex:z.number().int().min(1),decision:z.enum(["CONTINUE","REWORK","ACCEPT","WAIT","RECONCILE","ESCALATE","STOP"]),reason:z.string().min(1),instruction:z.string().min(1).optional(),waitForEvent:z.string().min(1).optional(),nextNodeId:z.string().min(1).optional()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
    async input=>({content:[{type:"text" as const,text:JSON.stringify(await callCore(core,"supervision.decide",input))}]}));
  server.registerTool("chief_dispatch_status", {
    description: "Read current Chief Conversation/Project binding, transport and authorized available Nodes before assigning work. A blocked state means stop and report it; never ask Human to copy prompts, wake Nodes or open another Chat. Session resources are internal. This read does not infer, create a Task or grant authority.",
    inputSchema: { targetNodeId: z.string().optional() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async input => {
    try {
      const status = await getReadView(core, "chief.status", { ...input, conversationRef: core.chiefConversationRef });
      return { content: [{ type: "text" as const, text: JSON.stringify(status) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ state: "BLOCKED",
        transport: "core_unavailable_or_not_chief", rawRouteErrors:[String(error)], humanRelayRequired: false, durableTaskCreated: false,
        message: "Chief 状态当前不可用；停止派发并报告 transport 状态。不要要求 Human 搬运提示词或创建其他 Chat。" }) }] };
    }
  });
  server.registerTool("task_dispatch", {
    description: "Persist a task without waiting. Chief root dispatch automatically checks transport, authorized Nodes and exact frontend binding; BLOCKED creates no Task. Report that state, never ask Human to copy prompts or open another Chat. During a Run supply parentRunId/checkpoint, end your turn on waiting_dependency; Core resumes you. Never resend uncertain work.",
    inputSchema: { requestId: z.string().uuid(), centerNodeId: z.string().min(1), body: z.string().min(1),
      basis: z.object({ responsibilityId:z.string().uuid(),intentRevisionId:z.string().uuid(),contextBasis:z.array(z.string().min(1)).min(1) }).optional(),
      supervisionId:z.string().uuid().optional(),
      parentRunId: z.string().uuid().optional(), checkpoint: z.string().min(1).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async input => {
    try {
      const result = await callCore(core, "task.submit", { ...input, frontendConversationRef: core.chiefConversationRef }) as Record<string, unknown>;
      return { isError: result.state === "BLOCKED", content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const,
        text: JSON.stringify({ state: "BLOCKED_OR_UNCERTAIN", humanRelayRequired: false,
          reason: error instanceof Error ? error.message : "uncertain: do not resend",
          message: "停止派发并保留 requestId；Human 无需搬运提示词，不创建其他 Chat。" }) }] };
    }
  });
  server.registerTool("task_get", {
    description: "Read an existing task in which your Node participates, without resending it.",
    inputSchema: { taskId: z.string().uuid() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ taskId }) => ({ content: [{ type: "text" as const,
    text: JSON.stringify(await getTaskView(core, taskId)) }] }));
  server.registerTool("session_active", {
    description: "Read your authenticated Sidera Node's active Session and exact Host locator. This does not change the Session or grant authority.",
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => ({ content: [{ type: "text" as const,
    text: JSON.stringify(await callCore(core, "session.active", {})) }] }));
  server.registerTool("host_control", {
    description: "Control an exact authorized Host Session. Discover with capabilities. Codex native controls include conversation.read/resume/interrupt/steer, session.inspect, model.list and tool.list. GPT UI controls include conversation.open/send/observe/interrupt/status when its isolated profile is ready. Human creates new frontend Conversations. Unsupported backends return unavailable; missing grants return denied. host_confirmed means the Host operation was acknowledged, not that an Agent task completed. On uncertain, do not resend.",
    inputSchema: { requestId: z.string().uuid(), targetSessionId: z.string().min(1),
      operation: z.string().min(1), input: z.record(z.string(), z.unknown()).default({}) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async input => {
    try {
      const result = await callCore(core, "host.control", input);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const,
        text: error instanceof Error ? error.message : "uncertain: reconcile without resending" }] };
    }
  });
}
