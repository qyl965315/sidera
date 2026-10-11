import { createHmac, timingSafeEqual } from "node:crypto";
import { SideraError } from "./types.ts";

/** Adapter attestation, never an RPC/tool parameter or an authorization grant.
 * The private Core credential authenticates the trusted gateway, which has
 * already checked its inbound credential and Human-owned deployment scope. */
export interface ChiefIngress {
  transport: "authenticated-mcp-pull";
  nodeId: string;
  edgeId: string;
  conversationRef: string;
  bindingId?: string;
  providerSession: "APPROVED_CORRELATION" | "UNVERIFIED";
  observedAt: number;
}
export interface ChiefSelector { bindingId?: string; projectRef?: string; conversationRef?: string }
export interface ChiefCaller { nodeId: string; sessionId: string; chiefIngress?: ChiefIngress }

export function signChiefIngress(token:string, request:{id:unknown;method:unknown;params:unknown}, ingress:ChiefIngress):string {
  return createHmac("sha256",token).update(JSON.stringify([request.id,request.method,request.params,ingress])).digest("hex");
}
export function verifyChiefIngress(token:string,request:Record<string,unknown>,nodeId:string):ChiefIngress|undefined {
  if(request.chiefIngress===undefined)return undefined;
  const ingress=request.chiefIngress as ChiefIngress;
  if(!ingress || ingress.transport!=="authenticated-mcp-pull" || ingress.nodeId!==nodeId ||
      typeof ingress.edgeId!=="string" || !ingress.edgeId || typeof ingress.conversationRef!=="string" || !ingress.conversationRef ||
      (ingress.bindingId!==undefined && (typeof ingress.bindingId!=="string" || !ingress.bindingId)) ||
      !["APPROVED_CORRELATION","UNVERIFIED"].includes(ingress.providerSession) ||
      !Number.isFinite(ingress.observedAt) || Date.now()-ingress.observedAt>60_000 || ingress.observedAt>Date.now()+1000)
    throw new SideraError("denied","Invalid authenticated MCP ingress scope");
  const expected=Buffer.from(signChiefIngress(token,{id:request.id,method:request.method,params:request.params},ingress));
  const actual=Buffer.from(typeof request.chiefIngressProof==="string"?request.chiefIngressProof:"");
  if(actual.length!==expected.length || !timingSafeEqual(actual,expected))
    throw new SideraError("denied","Untrusted MCP ingress attestation");
  return Object.freeze({...ingress});
}
