import { canonicalMcpServer, canonicalToolNames } from "./canonical-mcp.ts";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { incidentHeaders } from "./transport-incident.ts";
import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { callCore, getTaskView, type CoreClientConfig } from "./core-client.ts";
import { registerHostControl } from "./host-control-mcp.ts";
import { registerOrganizationControl } from "./organization-mcp.ts";
import { registerSubjectivityControl } from "./subjectivity-mcp.ts";

export interface GptHytheConfig {
  core: CoreClientConfig;
  /** @deprecated Ignored historical config alias; no special routing. */
  astraNodeId?: string;
  httpToken: string;
  port: number;
  readiness?: () => { ready: boolean; [key: string]: unknown };
  /** Non-secret protocol metadata only; never prompts, headers or tool results. */
  trace?: (entry: Record<string, unknown>) => void;
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith("Bearer ")) return false;
  const left = Buffer.from(actual.slice(7));
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function mcpServer(config:GptHytheConfig):McpServer {return canonicalMcpServer(config.core);}

/** Loopback only. A separate, authenticated tunnel is needed for ChatGPT testing. */
export async function startGptHythe(config: GptHytheConfig): Promise<Server> {
  if (!config.httpToken || !config.core.token) {
    throw new Error("GPT Hythe requires independent authentication and target configuration");
  }
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  const correlations = new WeakMap<object, string>();
  let inFlight=0;
  const trace = (entry: Record<string, unknown>) => { try { config.trace?.(entry); } catch { /* diagnostics cannot change requests */ } };
  app.get("/healthz", (_req, res) => res.json({ healthy: true, transport: "streamable-http-stateless" }));
  app.get("/readyz", (_req, res) => {
    const state = config.readiness?.() ?? { ready: true };
    res.status(state.ready ? 200 : 503).json(state);
  });
  app.use("/mcp", (req, res, next) => {
    if (!tokenMatches(req.header("authorization"), config.httpToken)) {
      res.status(401).end();
      return;
    }
    next();
  });
  app.post("/mcp", async (req, res) => {
    const packet = req.body;
    // Untrusted JSON-RPC metadata must not become a prompt/credential log.
    const methods = ["initialize", "ping", "notifications/initialized", "tools/list", "tools/call"];
    const tools = canonicalToolNames();
    const safeId = typeof packet?.id === "number" && Number.isSafeInteger(packet.id) ||
      typeof packet?.id === "string" && /^(?:\d{1,16}|[a-f0-9-]{36})$/i.test(packet.id);
    const entry = { at: new Date().toISOString(), layer: "local-mcp",
      method: methods.includes(packet?.method) ? packet.method : "other",
      jsonRpcId: safeId ? packet.id : null,
      tool: tools.includes(packet?.params?.name) ? packet.params.name : null,
      requestId: typeof packet?.params?.arguments?.requestId === "string" &&
        /^[a-f0-9-]{36}$/i.test(packet.params.arguments.requestId) ? packet.params.arguments.requestId : null };
    res.once("finish", () => trace({ ...entry, event: "protocol.response",
      localCorrelationId: correlations.get(req), httpStatus: res.statusCode,
      toolsCallSubmitted: entry.method === "tools/call", businessLogicInvoked: "UNKNOWN" }));
    const server = mcpServer(config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).end();
    } finally {
      await transport.close();
      await server.close();
    }
  });
  app.get("/mcp", (_req, res) => res.status(405).end());
  app.delete("/mcp", (_req, res) => res.status(405).end());
  return new Promise((resolve, reject) => {
    const listener = app.listen(config.port, "127.0.0.1", () => resolve(listener));
    if (config.trace) listener.prependListener("request", (req, res) => {
      const localCorrelationId = randomUUID(); correlations.set(req, localCorrelationId);
      const started=performance.now();inFlight++;let settled=false;
      const rawPath = (req.url ?? "").split("?")[0];
      const route = ["/mcp", "/healthz", "/readyz", "/sse", "/.well-known/oauth-protected-resource"].includes(rawPath) ? rawPath : "other";
      trace({ event: "http.received", localCorrelationId, method: req.method, route,
        receivedByLocalMcp: true, inFlightAtAdmission:inFlight,automaticRequestRetry:false, requestHeaders: incidentHeaders(req.headers) });
      res.once("finish", () => trace({ event: "http.response", localCorrelationId,
        method: req.method, route, httpStatus: res.statusCode,durationMs:performance.now()-started,
        inFlightAtResponse:inFlight, responseHeaders: incidentHeaders(res.getHeaders()) }));
      const settle=()=>{if(settled)return;settled=true;inFlight--;};
      res.once("finish",settle);res.once("close",()=>{
        if(!settled)trace({event:"http.closed",localCorrelationId,method:req.method,route,durationMs:performance.now()-started,completed:false,inFlight});settle();
      });
    });
    listener.once("error", reject);
  });
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href) {
  const corePort = Number(process.env.SIDERA_CORE_PORT);
  const port = Number(process.env.SIDERA_GPT_MCP_PORT ?? 8787);
  if (!Number.isInteger(corePort) || !Number.isInteger(port)) {
    throw new Error("SIDERA_CORE_PORT and SIDERA_GPT_MCP_PORT must be integers");
  }
  await startGptHythe({
    core: { port: corePort, token: process.env.SIDERA_GPT_CORE_TOKEN ?? "" },
    astraNodeId: process.env.SIDERA_ASTRA_NODE_ID ?? "",
    httpToken: process.env.SIDERA_GPT_MCP_TOKEN ?? "",
    port,
  });
}
