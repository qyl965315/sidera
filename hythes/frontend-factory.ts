import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ChiefFrontend } from "../core/chief.ts";
import { ChatGptNativeRoute } from "./chatgpt-native.ts";
import { HumanBoundary } from "./human-boundary.ts";
import { FrontendAdapterRegistry, type FrontendRouteSpec, type FrontendSpec } from "./frontend-registry.ts";
import { McpFrontendRoute } from "./mcp-frontend.ts";
import { readGatewayIngress } from "./gateway-ingress.ts";

export function defaultFrontendRegistry(): FrontendAdapterRegistry {
  return new FrontendAdapterRegistry()
    .register("codex-app-tools", spec => {
      if (spec.frontendKind !== "chatgpt-web" || !spec.options.nativeServerPath) throw new Error("Native ChatGPT bridge requires its real server path");
      return new ChatGptNativeRoute(String(spec.options.nativeServerPath), process.env.CODEX_THREAD_ID ?? "");
    })
    .register("mcp-http", spec => new McpFrontendRoute(spec));
}

export async function frontendFactory(db: DatabaseSync, project: string, spec?: FrontendSpec,
  registry: FrontendAdapterRegistry = defaultFrontendRegistry()): Promise<ChiefFrontend> {
  let declarations: FrontendRouteSpec[];
  if (spec?.routes !== undefined) declarations = spec.routes;
  else {
    // Historical UI configuration only selects its existing native bridge.
    // Unknown adapter kinds never silently acquire a ChatGPT route.
    const legacy = !spec?.kind || ["chatgpt-ui", "chatgpt-native", "codex-app-tools"].includes(spec.kind);
    const nativeServer = legacy ? spec?.options?.nativeServerPath ?? process.env.SIDERA_CODEX_APP_TOOLS_SERVER : undefined;
    declarations = nativeServer ? [{ id: "chatgpt:codex-app-tools", adapter: "codex-app-tools", frontendKind: "chatgpt-web", options: { nativeServerPath: nativeServer } }] : [];
  }
  const routes = await registry.create(declarations.filter(r=>r.enabled!==false), project);
  return new HumanBoundary(db, routes, binding => {
    const gateway=readGatewayIngress(project,binding?.chiefNodeId);
    try {
      const cached = JSON.parse(readFileSync(join(project, ".sidera-dev", "chief-ingress", "status.json"), "utf8"));
      const fresh = Date.now() - Date.parse(cached.at) < 90_000 && Date.now() >= Date.parse(cached.at);
      if(gateway&&(!fresh||cached.transportReady!==true))return gateway;
      return { ...cached, state: fresh ? (cached.transportReady ? "healthy" : "unavailable") : "unknown", lastKnownAt: cached.at,
        observation: fresh ? "live" : "last-known", transportReady: fresh && cached.transportReady, chatgptDispatchVerified: false };
    } catch (error) { return gateway ?? { state: "unknown", transportReady: false, rawRouteErrors: [String(error)], chatgptDispatchVerified: false }; }
  });
}
