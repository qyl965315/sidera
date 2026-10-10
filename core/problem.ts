/** R1 finite, versioned problem-code registry. It diagnoses canonical outcomes;
 * it does not own health, permissions, Host death or Effect transitions.
 */
import {SideraError,type SideraErrorCode} from "./types.ts";

export const PROBLEM_REGISTRY = {
  "SID-LIFE-1001":{category:"unavailable",httpStatus:503,description:"Runtime owner unavailable",retryProbe:true,humanAction:"inspect-owner"},
  "SID-LIFE-1002":{category:"conflict",httpStatus:409,description:"Another runtime owner holds this instance",retryProbe:false,humanAction:"inspect-owner"},
  "SID-OBS-2001":{category:"unavailable",httpStatus:503,description:"Fresh evidence missing or expired",retryProbe:true,humanAction:"inspect-evidence"},
  "SID-OBS-2002":{category:"unavailable",httpStatus:503,description:"Exact Host probe inconclusive",retryProbe:true,humanAction:"inspect-host"},
  "SID-OBS-2003":{category:"conflict",httpStatus:409,description:"Evidence object or generation mismatch",retryProbe:false,humanAction:"inspect-evidence"},
  "SID-EDGE-3001":{category:"unavailable",httpStatus:503,description:"Authenticated Gateway ingress unavailable",retryProbe:true,humanAction:"inspect-edge"},
  "SID-EDGE-3002":{category:"denied",httpStatus:401,description:"Connector authentication requires owner intervention",retryProbe:false,humanAction:"reauthorize-own-connector"},
  "SID-HOST-4001":{category:"unavailable",httpStatus:503,description:"Host cannot prove current exact Session",retryProbe:true,humanAction:"inspect-host"},
  "SID-HOST-4002":{category:"uncertain",httpStatus:409,description:"Existing Host Effect must be reconciled",retryProbe:true,humanAction:"reconcile-original"},
  "SID-AUTH-5001":{category:"denied",httpStatus:403,description:"Exact applicable authorization absent",retryProbe:false,humanAction:"review-governing-rules"},
  "SID-AUTH-5002":{category:"denied",httpStatus:403,description:"Human-rooted approval is missing",retryProbe:false,humanAction:"explicit-human-decision"},
  "SID-EFF-6001":{category:"uncertain",httpStatus:409,description:"Action has an unconfirmed external Effect",retryProbe:true,humanAction:"reconcile-original"},
  "SID-DATA-7001":{category:"unavailable",httpStatus:503,description:"Durable source integrity cannot be verified",retryProbe:false,humanAction:"inspect-canonical-source"},
  "SID-COMP-8001":{category:"unavailable",httpStatus:501,description:"Product does not expose the requested capability",retryProbe:false,humanAction:"inspect-provider-interface"},
  "SID-CORE-9000":{category:"unavailable",httpStatus:500,description:"Unclassified internal failure",retryProbe:false,humanAction:"inspect-redacted-diagnostics"},
  "SID-CORE-9001":{category:"denied",httpStatus:403,description:"Operation denied; exact reason not classified",retryProbe:false,humanAction:"inspect-authorization"},
  "SID-CORE-9002":{category:"not_found",httpStatus:404,description:"Exact requested object not found",retryProbe:false,humanAction:"inspect-references"},
  "SID-CORE-9003":{category:"conflict",httpStatus:409,description:"Operation conflicts with durable state",retryProbe:false,humanAction:"inspect-original-request"},
  "SID-CORE-9004":{category:"unavailable",httpStatus:503,description:"Requested operation is currently unavailable",retryProbe:true,humanAction:"inspect-condition"},
  "SID-CORE-9005":{category:"uncertain",httpStatus:409,description:"Original operation outcome requires reconciliation",retryProbe:true,humanAction:"reconcile-original"},
} as const satisfies Record<string,{category:SideraErrorCode;httpStatus:number;description:string;retryProbe:boolean;humanAction:string}>;
export type SideraProblemCode=keyof typeof PROBLEM_REGISTRY;
export interface ProblemView {
  version: "sidera-problem/1";
  code:SideraProblemCode;
  category:SideraErrorCode;
  httpStatus:number;
  summary:string;
  correlationId:string|null;
  evidenceRef:string|null;
  retryObservationAllowed:boolean;
  effectReplayPolicy:"NEVER_WITHOUT_NO_EFFECT_PROOF";
  humanAction:string;
}
export function problemView(code:SideraProblemCode, correlationId?:string,evidenceRef?:string):ProblemView {
  const item=PROBLEM_REGISTRY[code];
  return {version:"sidera-problem/1",code,category:item.category,httpStatus:item.httpStatus,
    summary:item.description,correlationId:correlationId??null,evidenceRef:evidenceRef??null,
    retryObservationAllowed:item.retryProbe,effectReplayPolicy:"NEVER_WITHOUT_NO_EFFECT_PROOF",
    humanAction:item.humanAction};
}
/** Only explicitly typed producers get specific stable reason codes; generic
 * legacy errors have a low-resolution fallback, not guessed text matching.
 */
export function rpcProblem(error:unknown):ProblemView {
  if(error instanceof SideraProblem)return problemView(error.problemCode);
  if(error instanceof SideraError){
    const generic:Record<SideraErrorCode,SideraProblemCode>={
      denied:"SID-CORE-9001",not_found:"SID-CORE-9002",conflict:"SID-CORE-9003",
      unavailable:"SID-CORE-9004",uncertain:"SID-CORE-9005"};
    return problemView(generic[error.code]);
  }
  return problemView("SID-CORE-9000");
}
export class SideraProblem extends SideraError {
  readonly problemCode:SideraProblemCode;
  constructor(problemCode:SideraProblemCode){
    super(PROBLEM_REGISTRY[problemCode].category,PROBLEM_REGISTRY[problemCode].description);
    this.problemCode=problemCode;
  }
}
