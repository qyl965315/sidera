import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ChiefBinding } from "../core/chief.ts";
import type { EffectBoundary } from "../core/effect-gate.ts";
import type { HumanRoute } from "./human-boundary.ts";
import { frontendBindingMatches, frontendBindingScopes, type FrontendBindingScope, type FrontendRouteSpec } from "./frontend-registry.ts";
import { crossEffect, providerAdmissionProfile } from "./effect-control.ts";
import { hostManifest } from "./manifest.ts";

const allowedOperations = new Set(["conversation.locate", "conversation.read", "conversation.observe", "conversation.send"]);

/**
 * Authenticated machine interface for any Chat Host with an MCP bridge.
 * Config maps semantic operations to real tools. Tools accept exact
 * {projectSpaceId,conversationRef,bindingId,...input} and return a canonical route observation:
 * {status, data:{conversationRef,...}, hostRef?}. No inferred completion or UI login.
 */
export class McpFrontendRoute implements HumanRoute {
  readonly id: string;
  readonly routeClass = "protocol" as const;
  readonly requirement = "Authenticated MCP endpoint with configured conversation tools";
  readonly manifest: HumanRoute["manifest"];
  private frontendKind: string;
  private endpoint: URL;
  private authTokenEnv: string;
  private operations: Record<string, string>;
  private bindings: FrontendBindingScope[];
  private profileId: string;
  private client?: Client;
  private connecting?: Promise<void>;
  private tools?: Set<string>;
  constructor(spec: FrontendRouteSpec) {
    this.id = spec.id;
    this.frontendKind = spec.frontendKind;
    this.bindings = frontendBindingScopes(spec.bindings, true)!;
    this.endpoint = new URL(String(spec.options.endpoint ?? ""));
    if (this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash ||
        !(this.endpoint.protocol === "https:" || (this.endpoint.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(this.endpoint.hostname))))
      throw new Error("MCP frontend requires HTTPS or loopback HTTP and environment-based authentication");
    this.authTokenEnv = String(spec.options.authTokenEnv ?? "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.authTokenEnv)) throw new Error("authTokenEnv is required");
    const operations = spec.options.operations;
    if (!operations || typeof operations !== "object" || Array.isArray(operations)) throw new Error("Explicit semantic tool mapping required");
    this.operations = {};
    for (const [operation, tool] of Object.entries(operations)) {
      if (!allowedOperations.has(operation) || typeof tool !== "string" || !tool.trim()) throw new Error("Invalid frontend operation mapping");
      this.operations[operation] = tool;
    }
    if (!this.operations["conversation.locate"] || !this.operations["conversation.send"]) throw new Error("Locate and send tools required");
    // Credential values remain Host-owned; the reference identifies which configured
    // account channel and endpoint the profile actually controls, without logging tokens.
    this.profileId = `${this.id}:mcp:${createHash("sha256").update(JSON.stringify({
      id: this.id, frontendKind: this.frontendKind, endpoint: this.endpoint.href, authTokenEnv: this.authTokenEnv,
      operations: Object.fromEntries(Object.entries(this.operations).sort(([a], [b]) => a.localeCompare(b))), bindings: this.bindings,
    })).digest("hex")}`;
    this.manifest = hostManifest({ hytheId: this.id, hostKind: this.frontendKind }, {
      operations: Object.keys(this.operations), routeClass: "protocol", createsSession: false,
    });
  }
  supportsBinding(binding: ChiefBinding) { return frontendBindingMatches(this.frontendKind, this.bindings, binding); }
  requirementSatisfied() {
    return Boolean(process.env[this.authTokenEnv] && (!this.tools || Object.values(this.operations).every(tool => this.tools!.has(tool))));
  }
  effectProfile() { return { ...providerAdmissionProfile(this.frontendKind, "Authenticated MCP conversation.send admission; exact project and conversation scope checked before send"), id: this.profileId }; }
  private async connect(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const token = process.env[this.authTokenEnv];
      if (!token) throw new Error("MCP frontend authentication is unavailable");
      const client = new Client({ name: "sidera-human-boundary", version: "1" });
      try {
        await client.connect(new StreamableHTTPClientTransport(this.endpoint, {
          requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: "error" },
          // No autonomous reconnect/replay, OAuth redirect, or browser callback.
          reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
        }), { timeout: 15_000 });
        this.tools = new Set((await client.listTools()).tools.map(tool => tool.name));
        if (!this.requirementSatisfied()) throw new Error("Configured MCP frontend tools were not exposed");
        this.client = client;
      } catch (error) { await client.close(); throw error; }
    })();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  async close() { await this.client?.close(); this.client = undefined; this.tools = undefined; }
  async invoke(operation: string, binding: ChiefBinding, input: Record<string, unknown> = {}, boundary?: EffectBoundary): Promise<Record<string, unknown>> {
    const reject = (reason: string) => ({ status: "rejected", beforeEffect: true, reason });
    if (!this.supportsBinding(binding) || !binding.conversationRef.trim()) return reject("Exact frontend binding required");
    const tool = this.operations[operation];
    if (!tool) return reject("Frontend operation is not configured");
    if (operation === "conversation.send" && !boundary) return reject("Final Core Effect boundary required");
    if (!this.requirementSatisfied()) return reject("MCP frontend authentication or required tools are unavailable");
    try { await this.connect(); } catch { return reject("Authenticated MCP frontend connection or tool discovery failed"); }
    const call = () => this.client!.callTool({ name: tool, arguments: {
      ...input, projectSpaceId: binding.projectSpaceId, conversationRef: binding.conversationRef, bindingId: binding.bindingId,
    } }, undefined, { timeout: 30_000 });
    const result = await (operation === "conversation.send"
      ? crossEffect(boundary, this.frontendKind, binding.conversationRef, operation, call) : call());
    if (result.isError) throw new Error("MCP frontend tool reported an error; any started send needs reconciliation");
    const text = (result.content as { type: string; text?: string }[]).filter(item => item.type === "text").map(item => item.text).join("\n");
    const output = (result.structuredContent ?? JSON.parse(text)) as Record<string, unknown>;
    const data = output.data as Record<string, unknown> | undefined;
    if (data?.conversationRef !== binding.conversationRef) throw new Error("MCP frontend response did not confirm the exact conversation");
    if (operation === "conversation.locate" && (output.status !== "host_confirmed" || data.located !== true))
      return reject("MCP frontend did not locate the exact conversation");
    if (operation === "conversation.send" && (!["accepted", "host_confirmed"].includes(String(output.status)) || typeof output.hostRef !== "string" || !output.hostRef))
      return { status: "uncertain", reason: "MCP send lacks explicit correlated Host acceptance" };
    return output;
  }
}
