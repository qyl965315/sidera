import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { TunnelLifecycle, type TunnelState } from "../hythes/tunnel-lifecycle.ts";
import { incidentTrace, nativeIncident } from "../hythes/transport-incident.ts";

const root = resolve(import.meta.dirname, ".."), dir = join(root, ".sidera-dev/chief-ingress");
mkdirSync(dir, { recursive: true });
const statePath = join(dir, "tunnel-state.json");
const lifecycle = new TunnelLifecycle({ state: existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) as TunnelState : undefined });
const persist = () => writeFileSync(statePath, JSON.stringify(lifecycle.snapshot(), null, 2));
const evidence = (entry: Record<string, unknown>) => appendFileSync(join(dir, "tunnel.jsonl"), JSON.stringify({ at: new Date().toISOString(), profile: "sidera-r1-astra-e2e", ...entry }) + "\n");
const incident = incidentTrace("native-tunnel", "tunnel_6abaf4d74e1081918b5153ac190d2c4a");
if (lifecycle.snapshot().state === "authentication_required" || lifecycle.snapshot().nextEstablishmentAt > Date.now()) {
  console.log(lifecycle.snapshot().state === "authentication_required"
    ? "Sidera tunnel authentication requires credential refresh; no connection or action is retried."
    : "Sidera tunnel establishment is cooling down; no action is replayed.");
  process.exitCode = 2;
} else {
  const ready = await lifecycle.readiness(async () => {
    const result = await fetch("http://127.0.0.1:8787/readyz", { signal: AbortSignal.timeout(3000) });
    return result.ok && (await result.json() as { ready?: boolean }).ready === true;
  });
  if (!ready) throw new Error("Local MCP ingress is not ready; no external connection attempted");
  persist();
  const child = spawn(join(root, ".sidera-dev/tunnel/bin/tunnel-client.exe"), ["run", "--profile", "sidera-r1-astra-e2e",
    "--profile-dir", join(root, ".sidera-dev/tunnel/profiles"), "--mcp.extra-headers", "Authorization: env:SIDERA_GPT_MCP_AUTH",
    "--mcp.discovery-extra-headers", "Authorization: env:SIDERA_GPT_MCP_AUTH"], { cwd: root, env: process.env,
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  evidence({ event: "started", pid: child.pid, nativeVersion: "0.0.14", automaticActionReplay: false });
  let circuitOpened = false;
  const onLine = (line: string) => {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line); } catch { return; }
    incident?.(nativeIncident(event));
    // Allowlist native diagnostics; never copy raw HTTP, error bodies or credentials.
    const status = Number(event.status_code);
    const message = String(event.msg ?? event.message ?? "");
    if (status || /poller started|poller recovered|startup probe|poller stopped/.test(message))
      evidence({ event: /^(?:poller |poll |startup probe)/.test(message) ? message.slice(0, 120) : "native-status",
        layer: "native-tunnel", status: status || null,
        retryInMs: Number(event.retry_in_ms) || null,
        tunnelServiceRequestId: typeof event.tunnel_request_id === "string" && /^[\w-]{1,128}$/.test(event.tunnel_request_id)
          ? event.tunnel_request_id : null,
        errorCode: typeof event.error_code === "string" && /^[\w.-]{1,80}$/.test(event.error_code) ? event.error_code : null,
        retryAfter: null, rateLimitHeaders: null, rawHeadersAvailable: false });
    if (status === 401 || status === 403) {
      lifecycle.authenticationRequired(); persist();
      circuitOpened = true; evidence({ event: "authentication_required", status, automaticActionReplay: false });
      child.kill();
    } else if (status === 429) {
      lifecycle.rateLimited(null, Number(event.retry_in_ms) || 0); persist();
      if ((incident || lifecycle.snapshot().state === "open") && !circuitOpened) {
        circuitOpened = true; evidence({ event: "circuit_open", ...lifecycle.snapshot(), automaticActionReplay: false });
        child.kill();
      }
    } else if (message.includes("poller recovered")) { lifecycle.recovered(); persist(); }
  };
  createInterface({ input: child.stdout! }).on("line", onLine);
  createInterface({ input: child.stderr! }).on("line", onLine);
  process.once("SIGINT", () => child.kill());
  process.once("SIGTERM", () => child.kill());
  child.once("error", () => { lifecycle.invalidate(); evidence({ event: "native_start_failed" }); process.exitCode = 1; });
  child.once("exit", code => {
    lifecycle.invalidate(); evidence({ event: "stopped", exitCode: code, circuitOpened });
    process.exitCode = circuitOpened ? 2 : code ?? 1;
  });
  console.log("Sidera tunnel supervised: one profile owner, native Retry-After/backoff, persistent 429 circuit.");
}
