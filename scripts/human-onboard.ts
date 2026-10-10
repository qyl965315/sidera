/**
 * Human-run root-authority activation.
 *
 * This is the ONLY path that creates Human root Authority for the local
 * deployment, and it is deliberately not reachable from any Node RPC, MCP tool,
 * model output or scheduled job. It is a privileged local operator ingress, in
 * the same trust class as the credential launcher.
 *
 * Subcommands:
 *   statement  Print the exact Human statements required. Read-only.
 *   admit      Human-run: capture and admit those exact statements. Requires
 *              an interactive confirmation on stdin.
 *   provision  Issue the bounded, non-delegable grants from the admitted acts.
 *   status     Print the fact-derived activation decision.
 *
 * Nothing here fabricates a Human act: the statements are shown in full, the
 * Human confirms them, and the recorded provenance names this mechanism.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { openDatabase } from "../core/db.ts";
import { SemanticStore } from "../core/semantics.ts";
import { recordWorld } from "../core/worlds.ts";
import { issueGrant } from "../core/authority.ts";
import { canonical, explicitHumanStatement, openHumanIngress, admitHumanAct, type HumanProposal } from "../core/human-admission.ts";
import { evaluateActivation, type ActivationInput } from "../core/activation.ts";

interface Spec { version: number; chiefNodeId: string; nodes: Array<{ nodeId: string; displayName: string }>; }
const root = resolve(import.meta.dirname, "..");
const dataDir = argument("data-dir") ?? join(root, ".sidera-dev", "sol", "data");
const dbPath = argument("db") ?? join(dataDir, "sidera.sqlite");

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function loadSpec(): Spec {
  const spec = JSON.parse(readFileSync(join(dataDir, "runtime-spec.json"), "utf8")) as Spec;
  if (spec.version !== 1 || !spec.chiefNodeId) throw new Error("Human-owned RuntimeSpec v1 required");
  return spec;
}
/** Optional `--only <nodeId,...>` scope: onboard exactly these declared Nodes
 * instead of every Node in the runtime configuration. It narrows the review set;
 * it never bypasses the Human admission step. */
function scopeNodes(): string[] {
  return (argument("only") ?? "").split(",").map(value => value.trim()).filter(Boolean);
}

/** Deterministic grant set: one self baseline per Node plus every directed edge. */
function requiredGrantInputs(db = openDatabase(dbPath)): Array<{ nodeId: string; input: Record<string, unknown> }> {
  const spec = loadSpec();
  const world = recordWorld(db, "nodes", spec.chiefNodeId);
  const nodes = spec.nodes.filter(node => {
    try { return recordWorld(db, "nodes", node.nodeId) === world; } catch { return false; }
  }).map(node => node.nodeId).sort();
  const only = scopeNodes();
  const selected = only.length ? nodes.filter(nodeId => only.includes(nodeId)) : nodes;
  const scopeSet = new Set(selected);
  const grants: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
  for (const nodeId of selected) grants.push({ nodeId, input: {
    requestId: `human-root:self:${nodeId}`, subjectNodeId: nodeId, capability: "self.*",
    resourceScope: `node/${nodeId}/**`, delegable: false, productScope: "*", effectScope: "admission",
    disclosureScope: "self_sovereign",
  }});
  for (const source of nodes) for (const target of nodes) {
    if (source === target) continue;
    // A scoped run provisions only the self baseline of the named Nodes. Dispatch
    // pairs are added only when the whole World is onboarded, so narrowing the
    // review set cannot silently widen authority between unrelated Nodes.
    if (only.length && !(scopeSet.has(source) && scopeSet.has(target))) continue;
    grants.push({ nodeId: source, targetNodeId: target, input: {
      requestId: `human-root:dispatch:${source}:${target}`, subjectNodeId: source,
      capability: "task.dispatch", resourceScope: `node/${target}`, delegable: false,
      productScope: "*", effectScope: "admission", disclosureScope: "handoff_bounded",
    }} as { nodeId: string; input: Record<string, unknown> });
  }
  return grants;
}
function proposalFor(entry: { nodeId: string; input: Record<string, unknown> }): HumanProposal {
  return { type: "authority.grant", objectRef: entry.nodeId,
    scope: String(entry.input.resourceScope), targetRevision: null,
    args: entry.input, causalRefs: ["human:local-operator-terminal"] };
}
function humanIdFor(db = openDatabase(dbPath)): string | undefined {
  const world = recordWorld(db, "nodes", loadSpec().chiefNodeId);
  const row = db.prepare("SELECT human_id FROM world_humans WHERE world_id=? ORDER BY human_id LIMIT 1").get(world) as { human_id: string } | undefined;
  return row?.human_id;
}

const command = process.argv[2] ?? "status";
if (command === "statement") {
  const db = openDatabase(dbPath);
  const entries = requiredGrantInputs(db);
  const payload = entries.map(entry => ({ nodeId: entry.nodeId, statement: explicitHumanStatement(proposalFor(entry)) }));
  process.stdout.write(`${JSON.stringify({ count: payload.length, statements: payload }, null, 2)}\n`);
  db.close();
} else if (command === "admit") {
  if (!process.stdin.isTTY) throw new Error("Human ingress requires an interactive terminal; refusing non-interactive admission");
  const label = argument("human") ?? "Local Human (Project Manager)";
  const db = openDatabase(dbPath);
  const spec = loadSpec();
  const world = recordWorld(db, "nodes", spec.chiefNodeId);
  const store = new SemanticStore(db, world);
  let human = humanIdFor(db);
  if (!human) {
    human = store.createHuman(label,
      `local operator declared this Human principal at ${new Date().toISOString()} through the Human-run activation tool; not derived from any provider account or Node claim`);
    process.stdout.write(`Created HumanPrincipal ${human} in World ${world}\n`);
  }
  const source = openHumanIngress(db, { worldId: world, humanId: human,
    presenceRef: `local-terminal:${process.env.COMPUTERNAME ?? "host"}`,
    sourceRef: `human-operator-terminal:${new Date().toISOString().slice(0, 10)}` });
  const entries = requiredGrantInputs(db);
  process.stdout.write(`\n${entries.length} exact Human statements will be recorded as one reviewed batch.\n`);
  for (const [index, entry] of entries.entries()) process.stdout.write(`${index + 1}. ${entry.nodeId} ${String(entry.input.capability)} ${String(entry.input.resourceScope)}\n`);
  process.stdout.write(`\nDigest: ${createHash("sha256").update(canonical(entries.map(proposalFor))).digest("hex")}\n`);
  process.stdout.write('Type ADMIT to record these exact statements, anything else aborts: ');
  const answer = (await new Promise<string>(done => process.stdin.once("data", value => done(String(value).trim())))).toUpperCase();
  if (answer !== "ADMIT") { process.stdout.write("Aborted; no Human act was recorded.\n"); db.close(); }
  else {
    let admitted = 0;
    for (const entry of entries) {
      const proposal = proposalFor(entry);
      const body = explicitHumanStatement(proposal);
      const messageId = `human-act:${createHash("sha256").update(body).digest("hex").slice(0, 32)}`;
      const utteranceId = source.capture(messageId, body);
      admitHumanAct(db, { worldId: world, humanId: human, utteranceId, proposal });
      admitted++;
    }
    process.stdout.write(`Recorded ${admitted} admitted Human acts for ${human} in World ${world}.\n`);
    db.close();
  }
} else if (command === "provision") {
  const db = openDatabase(dbPath);
  const human = humanIdFor(db);
  if (!human) throw new Error("No Human principal exists; run `admit` first");
  const world = recordWorld(db, "nodes", loadSpec().chiefNodeId);
  const actFor = (entry: { nodeId: string; input: Record<string, unknown> }) => {
    const act = db.prepare(`SELECT act_id FROM human_semantic_acts WHERE world_id=? AND human_id=?
      AND act_type='authority.grant' AND object_ref=? AND args_json=?`)
      .get(world, human, entry.nodeId, canonical(entry.input)) as { act_id: string } | undefined;
    if (!act) throw new Error(`No admitted Human act for ${entry.nodeId} ${String(entry.input.capability)}; run \`admit\` first`);
    return act.act_id;
  };
  let issued = 0;
  for (const entry of requiredGrantInputs(db)) {
    const actId = actFor(entry);
    issueGrant(db, { kind: "human", id: human, actId }, entry.input as never);
    issued++;
  }
  process.stdout.write(`Issued ${issued} bounded, non-delegable Human-rooted grants in World ${world}.\n`);
  db.close();
} else if (command === "status") {
  const db = openDatabase(dbPath);
  const spec = loadSpec();
  const world = recordWorld(db, "nodes", spec.chiefNodeId);
  const session = db.prepare("SELECT session_id FROM sessions WHERE node_id=? AND state='active'").get(spec.chiefNodeId) as { session_id: string } | undefined;
  const input: ActivationInput = {
    worldId: world, chiefNodeId: spec.chiefNodeId, chiefSessionId: session?.session_id ?? spec.chiefNodeId,
    live: { frontendPresence: "UNAVAILABLE", chiefRuntimePresence: "UNAVAILABLE" },
    required: spec.nodes.filter(n => n.nodeId !== spec.chiefNodeId).map(n => ({ capability: "task.dispatch", resource: `node/${n.nodeId}` })),
  };
  process.stdout.write(`${JSON.stringify(evaluateActivation(db, input), null, 2)}\n`);
  db.close();
} else { throw new Error(`Unknown subcommand: ${command}`); }