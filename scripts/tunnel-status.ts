import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TunnelState } from "../hythes/tunnel-lifecycle.ts";

const root = resolve(import.meta.dirname, ".."), dir = join(root, ".sidera-dev/chief-ingress");
async function local(path: string, port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3000) });
    return { status: response.status, text: await response.text() };
  } catch { return { status: null, text: "" }; }
}
// Read local diagnostics once; never establish a connection or invoke an Agent.
const [mcp, health, ready, metrics] = await Promise.all([
  local("/readyz", 8787), local("/healthz", 8790), local("/readyz", 8790), local("/metrics", 8790),
]);
let binding: Record<string, unknown> | null = null;
try { binding = JSON.parse(mcp.text); } catch { /* unavailable */ }
const match = metrics.text.match(/^commands_poll_last_successful_timestamp_seconds(?:\{[^\n]*\})?\s+([\d.e+\-]+)$/m);
const timestamp = match ? Number(match[1]) * 1000 : 0;
const ageMs = timestamp > 0 ? Date.now() - timestamp : null;
const statePath = join(dir, "tunnel-state.json");
const circuit = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) as TunnelState : null;
const transportReady = mcp.status === 200 && binding?.ready === true && health.status === 200 && ready.status === 200 &&
  ageMs !== null && ageMs >= 0 && ageMs < 90_000 && circuit?.state === "closed";
const report = { at: new Date().toISOString(), profile: "sidera-r1-astra-e2e", endpoint: "http://127.0.0.1:8787/mcp",
  localMcp: { status: mcp.status, binding }, nativeHealthStatus: health.status, nativeReadyStatus: ready.status,
  lastSuccessfulControlPlanePoll: timestamp > 0 ? new Date(timestamp).toISOString() : null,
  pollAgeMs: ageMs, circuit, transportReady, chatgptDispatchVerified: false,
  note: "A successful control-plane poll proves authentication and connectivity; it does not prove a ChatGPT tool dispatch.",
  externalProbePerformed: false, automaticActionReplay: false };
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "status.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
