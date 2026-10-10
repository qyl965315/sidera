import { createHash } from "node:crypto";
import type { ChiefBinding } from "../core/chief.ts";
import type { HumanRoute } from "./human-boundary.ts";
import { hostManifest } from "./manifest.ts";

/** Route configuration names an adapter, never a Node pair or a model. */
export interface FrontendBindingScope {
  projectSpaceId: string;
  conversationRef: string;
  /** Optional additional pin to one binding revision, useful after a handoff. */
  bindingId?: string;
}
export interface FrontendRouteSpec {
  /** Human configuration switch; grants no authority. */
  enabled?: boolean;
  id: string;
  adapter: string;
  frontendKind: string;
  /** Mandatory for protocol routes. Entries are exact tuples, never patterns. */
  bindings?: FrontendBindingScope[];
  options: Record<string, unknown>;
}
export interface FrontendSpec {
  /** Legacy single-frontend configuration remains readable. */
  kind?: string;
  options?: Record<string, unknown>;
  routes?: FrontendRouteSpec[];
}
export type FrontendAdapterFactory = (spec: FrontendRouteSpec, context: { project: string }) => HumanRoute | Promise<HumanRoute>;

/** Snapshot scope so later config mutation cannot broaden an already prepared route. */
export function frontendBindingScopes(bindings: FrontendBindingScope[] | undefined, required: boolean): FrontendBindingScope[] | undefined {
  if (bindings === undefined && !required) return undefined;
  if (!Array.isArray(bindings) || !bindings.length) throw new Error("Protocol frontend requires an explicit exact binding scope");
  return bindings.map(scope => {
    if (!scope || typeof scope !== "object" ||
        typeof scope.projectSpaceId !== "string" || !scope.projectSpaceId.trim() ||
        typeof scope.conversationRef !== "string" || !scope.conversationRef.trim() ||
        (scope.bindingId !== undefined && (typeof scope.bindingId !== "string" || !scope.bindingId.trim())))
      throw new Error("Frontend binding scope requires exact projectSpaceId and conversationRef");
    return { projectSpaceId: scope.projectSpaceId, conversationRef: scope.conversationRef,
      ...(scope.bindingId === undefined ? {} : { bindingId: scope.bindingId }) };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function frontendBindingMatches(frontendKind: string, scopes: FrontendBindingScope[] | undefined, binding: ChiefBinding): boolean {
  return binding.frontendKind === frontendKind && (scopes === undefined || scopes.some(scope =>
    scope.projectSpaceId === binding.projectSpaceId && scope.conversationRef === binding.conversationRef &&
    (scope.bindingId === undefined || scope.bindingId === binding.bindingId)));
}

/** Adapter construction is O(n). Binding isolation is enforced even for direct invocation. */
export class FrontendAdapterRegistry {
  private factories = new Map<string, FrontendAdapterFactory>();
  register(adapter: string, factory: FrontendAdapterFactory): this {
    if (!adapter.trim() || this.factories.has(adapter)) throw new Error(`Duplicate or empty frontend adapter: ${adapter}`);
    this.factories.set(adapter, factory);
    return this;
  }
  adapters(): string[] { return [...this.factories.keys()].sort(); }
  async create(specs: FrontendRouteSpec[], project: string): Promise<HumanRoute[]> {
    const ids = new Set<string>();
    for (const spec of specs) {
      if (!spec.id?.trim() || !spec.adapter?.trim() || !spec.frontendKind?.trim() || ids.has(spec.id))
        throw new Error("Frontend routes require unique ids, adapter and frontendKind");
      ids.add(spec.id);
    }
    const routes: HumanRoute[] = [];
    for (const spec of specs) {
      let route: HumanRoute;
      let scopes: FrontendBindingScope[] | undefined;
      let available = true;
      const frontendKind = spec.frontendKind;
      try {
        const factory = this.factories.get(spec.adapter);
        if (!factory) throw new Error("Frontend adapter is not registered");
        route = await factory(spec, { project });
        if (route.routeClass === "ui-fallback") {
          await route.close?.();
          throw new Error("Browser/UI routes are not production eligible");
        }
        try { scopes = frontendBindingScopes(spec.bindings, route.routeClass === "protocol"); }
        catch (error) { await route.close?.(); throw error; }
      } catch {
        // One offline/misconfigured Host must not prevent unrelated Chats from starting.
        // Do not expose arbitrary adapter errors: options may describe private credentials.
        available = false;
        route = {
          id: spec.id, routeClass: "protocol", requirement: `Adapter ${spec.adapter} unavailable or invalid`,
          requirementSatisfied: () => false,
          manifest: hostManifest({ hytheId: spec.id, hostKind: spec.frontendKind }, { operations: [], routeClass: "protocol", createsSession: false }),
          invoke: async () => ({ status: "rejected", beforeEffect: true, reason: "Configured frontend adapter is unavailable" }),
        };
      }
      const supportsBinding = (binding: ChiefBinding) => available && frontendBindingMatches(frontendKind, scopes, binding) &&
        (route.supportsBinding?.(binding) ?? true);
      const profile = route.effectProfile?.();
      const profileId = profile && route.routeClass === "protocol" ? `${spec.id}:protocol:${createHash("sha256")
        .update(JSON.stringify({ adapter: spec.adapter, frontendKind, scopes, profile })).digest("hex")}` : profile?.id;
      routes.push({
        id: spec.id, routeClass: route.routeClass,
        manifest: { ...route.manifest, hytheId: spec.id }, supportsBinding,
        requirement: route.requirement,
        requirementSatisfied: () => route.requirementSatisfied?.() ?? !route.requirement,
        effectProfile: profile ? () => ({ ...profile, id: profileId! }) : undefined,
        invoke: (operation, binding, input, boundary) => supportsBinding(binding)
          ? route.invoke(operation, binding, input, boundary)
          : Promise.resolve({ status: "rejected", beforeEffect: true, reason: "Frontend route does not admit this exact binding" }),
        close: () => route.close?.() ?? Promise.resolve(),
      });
    }
    return routes;
  }
}
