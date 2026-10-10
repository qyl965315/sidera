export interface HostMessage {
  hostRef: string;
  body: string;
  observedMessageId?: string;
  outcome?: "completed" | "failed";
}

export type InvokeResult =
  | { status: "accepted"; hostRef: string }
  | { status: "rejected"; reason: string }
  | { status: "uncertain"; reason: string };

export interface Hythe {
  effectProfile?(operation:string):import("../core/effect-gate.ts").EffectControlProfile|undefined;
  readonly hytheId: string;
  readonly hostKind: string;
  manifest?(): import("./manifest.ts").CapabilityManifest;
  capabilities(): readonly string[];
  canStartTurn?(): boolean;
  /** Current transport diagnostics only, never a substitute for locate/live execution. */
  diagnostics?():Record<string,unknown>;
  /** Read a terminal provider turn by its exact ID; never starts or replays inference. */
  completedTurn?(locatorRef:string,hostRef:string,messageId:string):Promise<HostMessage|null>;
  /** Optional native host controls. Authority and durable replay handling belong to Core. */
  controls?(): readonly string[];
  control?(locatorRef: string, operation: string, input: Record<string, unknown>, boundary?:import("../core/effect-gate.ts").EffectBoundary): Promise<Record<string, unknown>>;
  controlRoutes?(locatorRef:string,operation:string,input:Record<string,unknown>): import("../core/control-plane.ts").RouteCandidate[];
  createSession?(boundary?:import("../core/effect-gate.ts").EffectBoundary,sourceLocator?:string): Promise<string>;
  /** Only a definite missing/ephemeral resource permits a distinct replacement, never a replay. */
  canReplaceLostSession?(locatorRef:string): boolean;
  modelBinding?(locatorRef:string): {provider:string;modelId:string;effort?:string}|null;
  onLifecycle?(listener: (event: import("./lifecycle.ts").LifecycleEvent) => void): () => void;
  /** Adapter supplies a fresh locator only for an unsent wake. */
  needsFreshWake?(locatorRef:string):boolean;
  prepareWake?(locatorRef: string,boundary?:import("../core/effect-gate.ts").EffectBoundary): Promise<string>;
  locate(locatorRef: string): Promise<boolean>;
  invoke(
    locatorRef: string,
    capability: string,
    input: unknown,
    requestId: string,
    boundary?: import("../core/effect-gate.ts").EffectBoundary,
  ): Promise<InvokeResult>;
  receive(locatorRef: string, cursor?: string): AsyncIterable<HostMessage>;
  acceptResult?(runId: string, messageId: string, body: string): Promise<void>;
}
