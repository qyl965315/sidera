import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export interface ToolCallbackExtra {
  _meta?: Record<string, unknown>;
}
export type ToolCallbackObserver = (toolName:string,extra:ToolCallbackExtra)=>void;
export type ToolCallbackAround = (toolName:string,extra:ToolCallbackExtra,invoke:()=>unknown)=>unknown;
const names=new WeakMap<McpServer,Set<string>>();
const details=new WeakMap<McpServer,Array<{name:string;description:string;readOnly:boolean}>>();
/**
 * The observer receives the SDK ToolCallback extra, never model-supplied tool
 * arguments. It is optional so canonical MCP callers retain their contract.
 */
export function captureTools(server:McpServer,observer?:ToolCallbackObserver,around?:ToolCallbackAround):McpServer {
  const recorded=new Set<string>();names.set(server,recorded);
  const entries:Array<{name:string;description:string;readOnly:boolean}>=[];details.set(server,entries);
  const register=server.registerTool.bind(server);
  server.registerTool=((name:string,...args:unknown[])=>{
    if (recorded.has(name)) throw new Error(`Duplicate canonical tool: ${name}`);
    const config=args[0] as {description?:string;annotations?:{readOnlyHint?:boolean};inputSchema?:unknown};
    const callback=args.at(-1);
    if((observer||around)&&typeof callback==="function"){
      args[args.length-1]=(...callbackArgs:unknown[])=>{
        // SDK ToolCallback is (args, extra) for tools with inputSchema and
        // (extra) otherwise. Keep observation non-blocking by design.
        const extra=(config.inputSchema===undefined?callbackArgs[0]:callbackArgs[1]) as ToolCallbackExtra;
        try{observer?.(name,extra);}catch{/* diagnostics cannot change tool behavior */}
        const invoke=()=>callback(...callbackArgs);
        // Unlike diagnostics, an authenticated boundary wrapper may reject the
        // call. Never swallow that rejection or run the handler outside it.
        return around?around(name,extra,invoke):invoke();
      };
    }
    const result=(register as Function)(name,...args);recorded.add(name);entries.push({name,description:config.description??name,readOnly:config.annotations?.readOnlyHint===true});return result;
  }) as typeof server.registerTool;
  return server;
}
export function registeredToolNames(server:McpServer):string[] {return [...names.get(server) ?? []];}
export function registeredToolDetails(server:McpServer){return [...details.get(server)??[]];}

/**
 * Canonical operation naming.
 *
 * A registered canonical MCP tool name is the single source of truth for which
 * operations exist. The semantic Sidera operation is the dotted form of that
 * tool name, so a newly registered canonical tool appears in every derived
 * catalog without a second hand-maintained list.
 *
 * A handful of legacy tool names do not mechanically dotted-form into their
 * Core RPC method. That is a *naming* exception table, not an operation list:
 * membership still comes from canonical registration, and every entry here is
 * checked against the registered set by tests/audit. Do not add an operation
 * here to make a missing tool appear.
 */
export const CANONICAL_OPERATION_ALIASES: Readonly<Record<string,string>> = Object.freeze({
  task_rules_adopt: "rules.adopt",
  chief_presentation_observe: "chief.presentation_observe",
  chief_presentation_correct: "chief.presentation_correct",
  project_source_read: "project.source_read",
  history_event_get: "history.event_get",
  grant_from_rules: "grant.from_rules",
  chief_conversation_role: "chief.conversation_role",
  chief_frontend_prepare: "chief.frontend_prepare",
  chief_result_get: "chief.result_get",
  message_reconcile_result: "message.reconcile_result",
  task_reconcile_result: "task.reconcile_result",
  conflict_review_object: "conflict.review_object",
  consequence_review_object: "consequence.review_object",
  rules_review_object: "rules.review_object",
  workspace_write_text: "peregrine.write_text",
  workspace_read_text: "peregrine.read_text",
  write_e2e_marker: "peregrine.write_e2e_marker",
});

/** Dotted semantic operation for one registered canonical tool name. */
export function canonicalOperationForTool(toolName:string):string {
  return CANONICAL_OPERATION_ALIASES[toolName] ?? toolName.replaceAll("_",".");
}

/** Dotted operation -> canonical tool name, derived from the live registration. */
export function registeredToolOperations(server:McpServer):Map<string,string> {
  const operations=new Map<string,string>();
  for(const tool of registeredToolNames(server)){
    const operation=canonicalOperationForTool(tool);
    const prior=operations.get(operation);
    if(prior)throw new Error(`Canonical tools ${prior} and ${tool} both resolve to operation ${operation}`);
    operations.set(operation,tool);
  }
  return operations;
}
