import type { wakeContext } from "../core/subjectivity.ts";
export type WakeContext = ReturnType<typeof wakeContext>;

/** Canonical present-state header for every Host adapter; no transcript/history dump. */
export function renderWakeContext(context?: WakeContext): string {
  if (!context) return "";
  return `Events wake a Node; tensions move it. Choose your own meaningful tension under the world's Rules.\n`+
    `Node identity: ${JSON.stringify(context.identity)}\n`+
    `Current Description: ${context.subjectivity.description}\n`+
    `Current Explanation: ${context.subjectivity.explanation}\n`+
    `Subjectivity revision: ${context.subjectivity.revision}\n`+
    `Roles: ${JSON.stringify(context.roles)}\n`+
    `Accepted Responsibilities: ${JSON.stringify(context.responsibilities)}\n`+
    `Proposals (accept before commitment): ${JSON.stringify(context.proposals)}\n`+
    `Open/waiting Tensions: ${JSON.stringify(context.tensions)}\n`+
    `Sovereign Memory is exactly Description + Explanation. Description is subjective past impression/current self; Explanation includes causal models, principles, motives, rules, abstractions and world models. Neither is guaranteed fact. `+
    `Continuity is nodeId + D/Exp + lineage, not transcript replay. Public commitments cannot be erased by private revision. `+
    `CESAR dimensions are orthogonal: C Capability, S Sovereignty, A Authority, R Responsibility, E Effect (Eff); Explanation is Exp. Capability, Sovereignty and Responsibility do not grant Authority; Intent is not Effect. `+
    `Shared Pool (History, Evidence, Artifact, Decision, messages, receipts, commits and project state) is a permissioned world archive, never Agent Memory, Personality, Description or Explanation. `+
    `Only this Node revises its own Description/Explanation. Archive retrieval never updates them automatically. `+
    `Qwen is indexing/retrieval/accessibility infrastructure, not a judge, decision maker or project-direction author. `+
    `Human never forwards Agent messages or prompts. If dispatch transport is unavailable, report its exact status and stop; do not request a new Human Chat. `+
    `Shared History is evidence available on demand. No transcript is replayed in this context.\n`;
}
