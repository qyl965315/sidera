import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IncomingHttpHeaders } from "node:http";

const headerNames = ["x-request-id", "x-tunnel-request-id", "x-correlation-id", "retry-after",
  "cf-ray", "cf-mitigated", "content-type", "mcp-session-id"];
export function incidentHeaders(headers: IncomingHttpHeaders | Record<string, unknown>) {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (!headerNames.includes(name) && !/^x-ratelimit-[a-z-]+$/.test(name)) continue;
    if (typeof value !== "string" && !Array.isArray(value)) continue;
    result[name] = sanitizeIncidentText(Array.isArray(value) ? value.join(",") : value).slice(0, 300);
  }
  return result;
}
export function sanitizeIncidentText(value: unknown): string {
  let text = String(value ?? "");
  for (const name of ["SIDERA_TUNNEL_RUNTIME_KEY", "SIDERA_GPT_MCP_AUTH", "CONTROL_PLANE_API_KEY"])
    if (process.env[name]) text = text.replaceAll(process.env[name]!, "[REDACTED]");
  return text.replace(/sk-[\w-]+|Bearer\s+[^\s"',}]+/gi, "[REDACTED]")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[REDACTED]")
    .replace(/([?&](?:token|code|key|secret)=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/[\r\n\u0000]/g, " ").slice(0, 2000);
}
/** Opt-in diagnostics only. Never persist input/output bodies, credentials or all headers. */
export function incidentTrace(layer: string, tunnelId: string) {
  const dir = process.env.SIDERA_TRANSPORT_INCIDENT_DIR;
  if (!dir) return undefined;
  mkdirSync(dir, { recursive: true });
  return (entry: Record<string, unknown>) => {
    try {
      appendFileSync(join(dir, `${layer}.jsonl`), JSON.stringify({ ...entry,
        at: new Date().toISOString(), localAt: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }) + "+08:00",
        timezone: "Asia/Shanghai", layer, tunnelId }) + "\n");
    } catch { process.stderr.write("Transport incident evidence write failed; request behavior unchanged\n"); }
  };
}
export function nativeIncident(event: Record<string, unknown>) {
  const safe = (key: string) => typeof event[key] === "string" ? sanitizeIncidentText(event[key]) : null;
  const headers = incidentHeaders((event.response_headers ?? {}) as Record<string, unknown>);
  return {
    event: "native.event", nativeTime: safe("time"), component: safe("component"),
    message: safe("msg") ?? safe("message"), status: Number(event.status_code) || null,
    nativeRequestId: safe("request_id"), gatewayRequestId: safe("tunnel_request_id"),
    commandRequestId:safe("cmd_request_id"),traceId:safe("trace_id"),correlationId:safe("correlation_id"),
    clientInstanceId: safe("client_instance_id"), sessionId: safe("session_id"),
    method: safe("method"), route: safe("path"), responseHeaders: headers,
    retryAfter: headers["retry-after"] ?? safe("retry_after"), retryInMs: Number(event.retry_in_ms) || null,
    error: { type: safe("error_type"), code: safe("error_code"), message: safe("error_message"), mitigation: safe("mitigation") },
    nativeError: safe("error"), originalHttpBody: null,
    originalHttpBodyAvailable: false, rawHttpLoggingEnabled: false,
  };
}
