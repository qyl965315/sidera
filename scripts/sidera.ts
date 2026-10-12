import {captureHumanGoal} from "../core/local-human-intent.ts";
import {runHeadlessDoctor} from "./headless-doctor.ts";
import {checkConfiguration} from "../core/configuration.ts";
export {checkConfiguration} from "../core/configuration.ts";
/** Local operator CLI. Privileged Human entry is explicit and never exposed as Node RPC. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { callCore } from "../hythes/core-client.ts";
import { hostFactories } from "../hythes/host-factories.ts";
import { defaultFrontendRegistry } from "../hythes/frontend-factory.ts";
import { planDevelopmentProfile, type DevelopmentProfileInput, type DevelopmentProfileMode } from "../core/development-profile.ts";
import type { SemanticBasis } from "../core/semantics.ts";
import type { RuntimeSpec } from "../core/service.ts";
import type { FrontendSpec } from "../hythes/frontend-registry.ts";
import { openDatabase, withTransaction } from "../core/db.ts";
import { SemanticStore } from "../core/semantics.ts";
import { openHumanIngress, admitHumanAct, canonical, explicitHumanStatement, type HumanProposal } from "../core/human-admission.ts";
import { applyPermissionPackage, materializePermissionPackage, packageActArgs, type PermissionPackageManifest } from "../core/permission-package.ts";

const help = `Sidera operator CLI (Node >= 24, from the repository root)
  node scripts/sidera.ts status [--node <nodeId>]
  node scripts/sidera.ts nodes [--node <nodeId>]
  node scripts/sidera.ts inspect <task|responsibility|supervision> <id> [--node <nodeId>]
  node scripts/sidera.ts config-check
  node scripts/sidera.ts doctor [--root <workspace>] [--public] [--timeout-ms 100..5000]
  node scripts/sidera.ts profile <read-only|workspace|full-access> <config.json>
  node scripts/sidera.ts profile-apply <read-only|workspace|full-access> <config.json> --human <humanId>
  node scripts/sidera.ts intent --file <Human-goal.txt> --human <humanId> --world <worldId>
  node scripts/sidera.ts request --file <Human-goal.txt> --human <humanId> --world <worldId> [--node <nodeId>]
  node scripts/sidera.ts cooperate --goal-file <path> --basis-file <path> [--node <nodeId>]

Read commands make no dispatch. Profile only prints an admission plan.
Profile-apply reviews one concrete package in an interactive Human terminal.
Intent is the privileged local Human goal entry; it preserves literal text and
cannot create a Grant or interpret a model message as Human authorization.
Cooperate submits once with an already admitted SemanticBasis. Its request ID is
saved before submission; an uncertain response is never automatically retried.
The default caller is the existing configured Chief Node. Credentials stay local.
`;

function textFile(path: string): string {
  try {
    if (statSync(path).size > 1_048_576) throw new Error("large");
    return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  } catch { throw new Error("Input file is missing, unreadable, or larger than 1 MiB"); }
}
function jsonFile(path: string): unknown {
  const text = textFile(path);
  try { return JSON.parse(text); } catch { throw new Error("Input file must contain valid JSON"); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}
function take(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--") || args.lastIndexOf(option) !== index) throw new Error(`Provide exactly one value for ${option}`);
  args.splice(index, 2);
  return value;
}
const credentialField = /(?:password|secret|credential|authorization|cookie|api[_-]?key|(?:^|_)token$|Token$)/i;
function secretValues(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) { for (const child of value) secretValues(child, result); }
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    if (credentialField.test(key) && typeof child === "string" && child.length >= 8) result.add(child);
    else secretValues(child, result);
  }
  return result;
}
function redact(value: unknown, secrets: Set<string>): unknown {
  if (typeof value === "string") { for (const secret of secrets) value = (value as string).split(secret).join("[redacted]"); return value; }
  if (Array.isArray(value)) return value.map(child => redact(child, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, credentialField.test(key) ? "[redacted]" : redact(child, secrets)]));
  return value;
}
function persist(path: string, value: unknown): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}
type CooperationBasis = Omit<SemanticBasis,"responsibilityId"> & {responsibilityId?:string};
function readBasis(value: unknown): CooperationBasis {
  const basis = object(value);
  if (basis.responsibilityId!==undefined && (typeof basis.responsibilityId !== "string" || !basis.responsibilityId.trim()) ||
    typeof basis.intentRevisionId !== "string" || !basis.intentRevisionId.trim() ||
    !Array.isArray(basis.contextBasis) || !basis.contextBasis.length || basis.contextBasis.some(ref => typeof ref !== "string" || !ref.trim()))
    throw new Error("basis-file requires an existing intentRevisionId and nonempty contextBasis; responsibilityId is optional");
  return { ...(basis.responsibilityId?{responsibilityId:basis.responsibilityId as string}:{}), intentRevisionId: basis.intentRevisionId, contextBasis: basis.contextBasis as string[] };
}

/** Trusted local Human frontend. Never call from a Node RPC or model tool. */
function captureGoalFile(root:string,file:string,humanId:string,worldId:string) {
  return captureHumanGoal(root,textFile(resolve(file)),humanId,worldId,pathToFileURL(resolve(file)).href);
}

export interface ProfileApprovalPrompt {
  mode:DevelopmentProfileMode; digest:string; manifest:PermissionPackageManifest; confirmationText:string;
}
/** Only dependency injection for a trusted operator/test frontend; no CLI switch can supply this. */
export interface OperatorTerminal {
  isInteractive():boolean;
  confirmProfile(review:ProfileApprovalPrompt):Promise<string>;
}
const localTerminal:OperatorTerminal={
  isInteractive:()=>Boolean(process.stdin.isTTY&&process.stdout.isTTY),
  async confirmProfile(review){
    const prompt=createInterface({input:process.stdin,output:process.stdout});
    try{return await prompt.question(`Type ${review.confirmationText} to approve this exact package, or anything else to cancel: `);}
    finally{prompt.close();}
  },
};
export async function applyProfile(root:string,input:DevelopmentProfileInput,humanId:string,terminal:OperatorTerminal,output:(value:unknown)=>void):Promise<number>{
  const plan=planDevelopmentProfile(input),manifest=JSON.parse(canonical(plan.manifest)) as PermissionPackageManifest;
  const args=packageActArgs(manifest),worldId=manifest.worldId,exact=canonical(args);
  const db=openDatabase(join(root,".sidera-dev","sol","data","sidera.sqlite"));
  try{
    if(!db.prepare("SELECT 1 FROM world_humans WHERE world_id=? AND human_id=?").get(worldId,humanId))throw new Error("Human must already belong to the selected World");
    const epoch=()=>Number(db.prepare("SELECT epoch FROM trust_policy WHERE world_id=?").get(worldId)!.epoch);
    const prior=()=>db.prepare(`SELECT act_id,policy_epoch FROM human_semantic_acts WHERE world_id=? AND human_id=?
      AND act_type='authority.grant_package' AND object_ref=? AND args_json=? ORDER BY recorded_at DESC LIMIT 1`)
      .get(worldId,humanId,manifest.packageId,exact) as {act_id:string;policy_epoch:number}|undefined;
    const establish=(actId:string,reused:boolean)=>{
      const act=db.prepare("SELECT policy_epoch FROM human_semantic_acts WHERE act_id=?").get(actId)!;
      if(Number(act.policy_epoch)!==epoch())throw new Error("Package policy is obsolete; review a new package revision");
      const unavailable=db.prepare(`SELECT 1 FROM grants g JOIN grant_provenance p USING(grant_id) WHERE p.human_act_id=?
        AND (g.revoked_at IS NOT NULL OR (g.expires_at IS NOT NULL AND g.expires_at<=?)) LIMIT 1`).get(actId,new Date().toISOString());
      if(unavailable)throw new Error("Package contains revoked or expired grants; review a new package revision");
      if(!db.prepare("SELECT 1 FROM human_act_applications WHERE act_id=?").get(actId))applyPermissionPackage(db,{id:humanId,actId},manifest);
      const result=materializePermissionPackage(db,{worldId,humanId,packageActId:actId});
      return {mode:plan.mode,digest:plan.digest,packageId:manifest.packageId,revision:manifest.revision,actId,
        reused,complete:result.complete,grantCount:result.grants.length,grants:result.grants};
    };
    const existing=prior();
    if(existing){output(withTransaction(db,"operator_profile_reuse",()=>establish(existing.act_id,true)));return 0;}
    const conflicting=db.prepare(`SELECT 1 FROM human_semantic_acts WHERE world_id=? AND human_id=? AND act_type='authority.grant_package'
      AND object_ref=? AND json_extract(args_json,'$.revision')=?`).get(worldId,humanId,manifest.packageId,manifest.revision);
    if(conflicting)throw new Error("This package revision already names another manifest; increment revision before review");
    if(!terminal.isInteractive()){
      output({state:"HUMAN_CONFIRMATION_REQUIRED",mode:plan.mode,digest:plan.digest,authorityGranted:false,
        reason:"First application requires an interactive Human terminal; flags and piped replies cannot approve"});return 2;
    }
    const reviewEpoch=epoch(),confirmationText=`APPROVE${plan.mode==="full-access"?" FULL ACCESS":""} ${plan.digest}`;
    const sourceRef=`human-operator-profile:${manifest.packageId}:r${manifest.revision}:${plan.digest}`;
    const proposal:HumanProposal={type:"authority.grant_package",objectRef:manifest.packageId,scope:`package/${manifest.packageId}`,
      targetRevision:null,args:args as unknown as Record<string,unknown>,causalRefs:[sourceRef]};
    const statement=explicitHumanStatement(proposal);
    output({state:"AWAITING_HUMAN_REVIEW",mode:plan.mode,humanId,digest:plan.digest,manifest,
      fullAccessWarning:plan.mode==="full-access"?"FULL ACCESS: review every added high-privilege scope before approving":null,
      exactStatement:statement,confirmationText,authorityGranted:false});
    const answer=await terminal.confirmProfile({mode:plan.mode,digest:plan.digest,manifest:structuredClone(manifest),confirmationText});
    if(answer.trim()!==confirmationText){output({state:"CANCELLED",authorityGranted:false});return 2;}
    const result=withTransaction(db,"operator_profile_apply",()=>{
      if(epoch()!==reviewEpoch)throw new Error("Trust policy changed during review; review again");
      const concurrentlyAdmitted=prior();if(concurrentlyAdmitted)return establish(concurrentlyAdmitted.act_id,true);
      const ingress=openHumanIngress(db,{worldId,humanId,presenceRef:"local-human-operator:interactive-profile-review",sourceRef});
      const answerId=ingress.capture(`${plan.digest}:typed-answer`,answer);
      const utteranceId=ingress.capture(`${plan.digest}:reviewed-statement`,statement,answerId);
      const proof=admitHumanAct(db,{worldId,humanId,utteranceId,proposal});
      return establish(proof.actId!,false);
    });
    output(result);return 0;
  }finally{db.close();}
}


export async function runOperator(argv: string[], options: { root?: string; invoke?: typeof callCore; output?: (value: unknown) => void; terminal?:OperatorTerminal } = {}): Promise<number> {
  const args = [...argv], command = args.shift(), root = resolve(options.root ?? process.env.SIDERA_PROJECT_ROOT ?? process.cwd());
  const output = options.output ?? (value => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2)));
  if (!command || command === "help" || command === "--help") { output(help); return 0; }
  if (command === "doctor") return runHeadlessDoctor(args, root, output);
  if (command === "profile" || command === "profile-apply") {
    const humanId=command==="profile-apply"?take(args,"--human"):undefined;
    const [mode, file] = args;
    if (args.length !== 2 || !["read-only", "workspace", "full-access"].includes(mode!) || command==="profile-apply"&&!humanId) throw new Error("Usage: profile[-apply] <read-only|workspace|full-access> <config.json> [--human <humanId>]");
    const input = object(jsonFile(resolve(file!))) as unknown as DevelopmentProfileInput;
    if(command==="profile-apply")return applyProfile(root,{...input,mode:mode as DevelopmentProfileMode},humanId!,options.terminal??localTerminal,output);
    output(redact(planDevelopmentProfile({ ...input, mode: mode as DevelopmentProfileMode }), secretValues(input)));
    return 0;
  }
  if (command === "intent") {
    const file=take(args,"--file"),humanId=take(args,"--human"),worldId=take(args,"--world");
    if(args.length||!file||!humanId||!worldId)throw new Error("Usage: intent --file <Human-goal.txt> --human <humanId> --world <worldId>");
    output(captureGoalFile(root,file,humanId,worldId).admission);return 0;
  }
  const selectedNode = take(args, "--node");
  const spec = object(jsonFile(join(root, ".sidera-dev", "sol", "data", "runtime-spec.json"))) as unknown as RuntimeSpec;
  const secrets = secretValues(spec), print = (value: unknown) => output(redact(value, secrets));
  if (command === "config-check") {
    if (args.length || selectedNode) throw new Error("config-check takes no arguments");
    const checked = checkConfiguration(spec); print(checked); return checked.valid ? 0 : 2;
  }
  if (spec.version !== 1 || !Array.isArray(spec.nodes)) throw new Error("RuntimeSpec v1 required");
  const node = spec.nodes.find(item => item.nodeId === (selectedNode ?? spec.chiefNodeId));
  if (!node?.coreToken) throw new Error("Caller Node has no configured RPC identity");
  const config = { port: spec.corePort, token: node.coreToken }, invoke = options.invoke ?? callCore;
  if (command === "status") {
    if (args.length) throw new Error("status takes only optional --node");
    print(await invoke(config, "chief.status", {})); return 0;
  }
  if (command === "nodes") {
    if (args.length) throw new Error("nodes takes only optional --node");
    const view = object(await invoke(config, "world.inspect", {}));
    print({ worldId: view.worldId, readOnly: true, nodes: view.nodes }); return 0;
  }
  if (command === "inspect") {
    const [kind, id] = args;
    if (args.length !== 2 || !["task", "responsibility", "supervision"].includes(kind!) || !id?.trim()) throw new Error("Usage: inspect <task|responsibility|supervision> <id>");
    print(await invoke(config, "work.inspect", { [`${kind}Id`]: id })); return 0;
  }
  if (command === "cooperate" || command === "request") {
    let goal:string,basis:CooperationBasis,admission:ReturnType<typeof captureGoalFile>["admission"]|undefined;
    if(command==="request"){
      const file=take(args,"--file"),humanId=take(args,"--human"),worldId=take(args,"--world");
      if(args.length||!file||!humanId||!worldId)throw new Error("request requires --file, --human and --world");
      const captured=captureGoalFile(root,file,humanId,worldId);goal=captured.body;admission=captured.admission;
      basis={intentRevisionId:admission.intentRevisionId,contextBasis:admission.contextBasis};
    }else{
      const goalFile=take(args,"--goal-file"),basisFile=take(args,"--basis-file");
      if(args.length||!goalFile||!basisFile)throw new Error("cooperate requires --goal-file and --basis-file with an already admitted basis");
      goal=textFile(resolve(goalFile));basis=readBasis(jsonFile(resolve(basisFile)));
    }
    if (!goal) throw new Error("Goal file cannot be empty");
    const requestId = randomUUID(), method = "cooperation.start", params = { requestId, goal, basis };
    const directory = join(root, ".sidera-dev", "operator-requests"); mkdirSync(directory, { recursive: true });
    const receipt = join(directory, `${requestId}.json`);
    persist(receipt, { requestId, method, callerNodeId: node.nodeId, at: new Date().toISOString(), state: "intent", params, admission });
    print({ requestId, receipt, state: "intent_saved", admission, automaticRetry: false });
    let result:unknown;
    try {
      result = await invoke(config, method, params);
    } catch (error) {
      const message = String(error), state = /Sidera (denied|conflict|not_found|invalid_argument):/i.test(message) ? "rejected" : "uncertain";
      persist(join(directory, `${requestId}.response.json`), redact({ requestId, at: new Date().toISOString(), state, error: message }, secrets));
      print({ requestId, receipt, state, error: message, automaticRetry: false,
        next: "Inspect the original request and canonical work records; do not resubmit an uncertain operation" });
      return 2;
    }
    persist(join(directory, `${requestId}.response.json`), redact({ requestId, at: new Date().toISOString(), state: "response_received", result }, secrets));
    print({ requestId, receipt, state: "response_received", result, automaticRetry: false });
    const state=typeof result === "object" && result !== null ? (result as {state?:string}).state : undefined;
    return state && ["blocked","failed","uncertain","rejected"].includes(state.toLowerCase()) ? 2 : 0;
  }
  throw new Error("Unknown command. Run node scripts/sidera.ts help");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await runOperator(process.argv.slice(2)); }
  catch { console.error("Sidera operator command failed before a confirmed response. Check command arguments, private configuration and the saved request receipt. No automatic retry was made."); process.exitCode = 2; }
}
