import type { EffectBoundary, EffectControlProfile } from "../core/effect-gate.ts";
import { SideraError } from "../core/types.ts";
import { operationEffect } from "./manifest.ts";

/** Interrupt admission is not proof that all autonomous effects have stopped. */
export function providerAdmissionProfile(product:string,boundary:string):EffectControlProfile {
  return {id:`${product}:admission`,version:"m2-v1",control:"ProviderAutonomousNonCancelable",
    boundary,admission:"Exact conversation prompt/control admission",
    businessEffects:["Provider may execute tools and modify its environment after admission"],
    cancellation:null,uncertainInterval:"Send initiation through correlated provider acknowledgement/result",
    externalIdentityRequired:true};
}
export function crossEffect<T>(boundary:EffectBoundary|undefined,product:string,locator:string,operation:string,send:()=>T):T {
  if(!boundary)throw new SideraError("denied","Final Core Effect boundary required");
  return boundary.cross({product,locator,operation},send);
}
