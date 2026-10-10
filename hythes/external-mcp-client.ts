import type {
  EffectControlProfile,
} from "../core/effect-gate.ts";
import type { CapabilityManifest } from "./manifest.ts";
import { hostManifest } from "./manifest.ts";
import type { HostMessage, Hythe, InvokeResult } from "./types.ts";

/**
 * Generic Host for an external product that reaches Sidera as an MCP client.
 *
 * One adapter serves every cloud Chat / external workflow edge. It is not
 * provider-specific and there is no per-product branch: the identity of the
 * product lives in the configured edge and its Sidera Node, never in this code.
 *
 * What this Host honestly can and cannot do:
 *
 *  - INBOUND operations are real. The external product calls the Sidera MCP
 *    Gateway; the Gateway authenticates its boundary credential, resolves the
 *    bound Node and calls Core as that Node's exact principal.
 *  - PROACTIVE operations are not claimed. Unless the product offers an official
 *    machine interface for Sidera to push a message into that exact conversation,
 *    there is no `message.receive`, no `conversation.send` and no Host-invented
 *    wake. Capability is not removed to look simple; it is withheld because the
 *    product does not provide it.
 *
 * The Runtime Session built from this adapter represents the exact external edge
 * currently bound to one Sidera Node. Its identity is never inferred from tool
 * arguments, product name, tunnel, model or network address: only the edge
 * boundary credential decides which Node a Gateway request acts as.
 */

export interface ExternalMcpClientOptions {
  /** Release edge this external client serves, e.g. "grok-chat". */
  edgeId: string;
  /** Reachability of the shared Sidera MCP Gateway. Identity does not live here:
   * this is where the client connects, not who it is. */
  gatewayEndpoint?: string;
  /** The locator this Session was declared with. A locator change is an explicit
   * configuration change, never a silent identity substitution. */
  locatorRef: string;
}

/** Inbound-only transport capabilities. `message.receive` is deliberately absent. */
export const EXTERNAL_MCP_CLIENT_OPERATIONS = ["session.inspect"] as const;
export const EXTERNAL_MCP_CLIENT_TRANSPORT = [] as const;

export class ExternalMcpClientHythe implements Hythe {
  readonly hytheId: string;
  readonly hostKind = "external-mcp-client";
  private readonly options: ExternalMcpClientOptions;

  constructor(hytheId: string, options: ExternalMcpClientOptions) {
    if (!hytheId?.trim()) throw new Error("External MCP client Host requires a Hythe identity");
    if (!options.edgeId?.trim()) throw new Error("External MCP client Host requires a release edge");
    if (!options.locatorRef?.trim()) throw new Error("External MCP client Host requires the declared locator");
    this.hytheId = hytheId;
    this.options = options;
  }

  /** No proactive receive exists for this Host. This is the honest answer, not a
   * placeholder that pretends an inbound-only edge can be pushed to. */
  capabilities(): readonly string[] {
    return [];
  }

  canStartTurn(): boolean {
    return false;
  }

  /** Inbound-only: no Host control operations are offered. */
  controls(): readonly string[] {
    return [];
  }

  manifest(): CapabilityManifest {
    return hostManifest(this, { routeClass: "protocol",
      operations: [...EXTERNAL_MCP_CLIENT_OPERATIONS], createsSession: false,
      transportCapabilities: [...EXTERNAL_MCP_CLIENT_TRANSPORT] });
  }

  /** Control profile for observability. An external client crossing the Gateway
   * is Sidera-controlled up to the Gateway boundary and provider-autonomous
   * afterwards, so a caller can never assume Sidera can retract a product action. */
  effectProfile(operation: string): EffectControlProfile | undefined {
    if (operation !== "message.receive" && operation !== "session.locate") return undefined;
    return { id: "external-mcp-client:inbound", version: "m1-v1",
      control: "ProviderAutonomousNonCancelable",
      // Sidera controls the Gateway boundary, not the product behind it.
      boundary: "External product reaches the Sidera MCP Gateway; Sidera has no retraction path into the product",
      admission: "Exact edge boundary credential resolved by the Gateway to one bound Node",
      businessEffects: ["The external product decides what it does with the Sidera result on its own side"],
      cancellation: null,
      uncertainInterval: "Gateway request admission through the external product's own acknowledgement",
      externalIdentityRequired: false };
  }

  /** This inbound-only adapter cannot locate an exact, proactively reachable
   * conversation. The configured locator is a binding, never proof of LIVE.
   * Authenticated inbound activity is recorded at Gateway scope instead.
   */
  async locate(_locatorRef: string): Promise<boolean> {
    return false;
  }

  diagnostics(): Record<string, unknown> {
    return { edgeId: this.options.edgeId, gatewayEndpoint: this.options.gatewayEndpoint ?? null,
      mode: "inbound-only", proactiveReceive: false,
      identitySource: "gateway edge boundary credential -> boundNodeId -> exact Node principal" };
  }

  /** No proactive invocation path exists. Refusing is the truthful result. */
  async invoke(): Promise<InvokeResult> {
    return { status: "rejected",
      reason: "External MCP client Host is inbound-only; Sidera has no proactive send into this product" };
  }

  /** An inbound-only edge produces no Host results. The stream closes immediately
   * so Core never fabricates progress for this Session. */
  async *receive(): AsyncGenerator<HostMessage> {
    return;
  }
}
