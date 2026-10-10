import { SideraError } from "./types.ts";

/** Protocol constants; not mutable World policy and never exposed as a Node mutation. */
export const BASIC_RULES_VERSION = "sidera-r1-constitution/1";
export const BASIC_INVARIANTS = Object.freeze([
  "CESAR concepts remain distinct", "Sovereignty is private self-authored D + E",
  "History is append-oriented with attributable monotonic order",
  "Claim does not promote its content to objective state",
  "Omega is rebuilt from History and deterministic Apply",
  "Incompatible same-base deltas remain locally unresolved",
  "Derived Authority and lower Rules cannot widen their parents",
  "Fork cannot erase existing provenance or responsibility",
  // Basic guarantees the *shape* of review/adoption, not its topology: an
  // adoption record must be explicit, versioned, traceable, bound to an exact
  // object/digest and a real completed review, and it may not break the parent
  // boundary. Who reviews, how many, whether they must be independent and
  // whether a Human is involved are institutional policy held by Rules.
  "Rule adoption binds an exact versioned object digest and scope",
  "A review or adoption record names the exact completed review it consumed",
]);

/** A level-local review/adoption policy. `reviewers` says which kinds must act. */
export interface RuleReviewPolicy {
  reviewers: "Human" | "Machine" | "Human+Machine";
  /** Which reviewer a machine review Task must resolve to. */
  reviewerSelection: "Human" | "AuthorizedOperator" | "ChiefConversation";
  humanInvolvement: "required" | "optional" | "none";
  /** The required reviewers must be a different subject than the issuer. */
  independentRequired: boolean;
  /** When false the issuer may not be one of its own reviewers. */
  allowSelfReview: boolean;
  /** Distinct completed machine reviews adoption must consume. */
  reviewerCount: number;
  /** Fixed by the machine-review procedure; no policy may relax it. */
  exactObjectHashRequired: true;
}

export const REVIEW_POLICY_FIELDS = Object.freeze(["reviewers", "reviewerSelection", "humanInvolvement",
  "independentRequired", "allowSelfReview", "reviewerCount", "exactObjectHashRequired"] as const);

export function normalizeReviewPolicy(value: unknown): RuleReviewPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SideraError("conflict", "reviewPolicy must be a structured object");
  const p = value as Record<string, unknown>;
  for (const key of Object.keys(p))
    if (!(REVIEW_POLICY_FIELDS as readonly string[]).includes(key))
      throw new SideraError("conflict", `Unknown reviewPolicy field ${key}`);
  const reviewers = p.reviewers, selection = p.reviewerSelection, human = p.humanInvolvement;
  if (!["Human", "Machine", "Human+Machine"].includes(String(reviewers)))
    throw new SideraError("conflict", "reviewPolicy.reviewers must be Human, Machine or Human+Machine");
  if (!["Human", "AuthorizedOperator", "ChiefConversation"].includes(String(selection)))
    throw new SideraError("conflict", "reviewPolicy.reviewerSelection is not a known reviewer class");
  if (!["required", "optional", "none"].includes(String(human)))
    throw new SideraError("conflict", "reviewPolicy.humanInvolvement must be required, optional or none");
  if (typeof p.independentRequired !== "boolean" || typeof p.allowSelfReview !== "boolean")
    throw new SideraError("conflict", "reviewPolicy independence flags must be boolean");
  if (p.exactObjectHashRequired !== undefined && p.exactObjectHashRequired !== true)
    throw new SideraError("denied", "Exact review object-hash binding cannot be relaxed");
  const machine = reviewers !== "Human", humanReviewer = reviewers !== "Machine";
  const count = p.reviewerCount;
  if (!Number.isSafeInteger(count) || (count as number) < 0)
    throw new SideraError("conflict", "reviewPolicy.reviewerCount must be a non-negative safe integer");
  if (machine && (count as number) < 1)
    throw new SideraError("conflict", "reviewPolicy with a Machine reviewer needs at least one reviewer");
  if (!machine && (count as number) !== 0)
    throw new SideraError("conflict", "A Human-only review policy has no machine reviewer count");
  if (!machine && selection !== "Human")
    throw new SideraError("conflict", "A Human-only review policy selects the Human reviewer");
  if (!machine && human !== "required")
    throw new SideraError("conflict", "A Human-only review policy requires Human involvement");
  if (machine && selection === "Human")
    throw new SideraError("conflict", "Machine review must select a Machine reviewer");
  if (reviewers === "Machine" && human === "required")
    throw new SideraError("conflict", "A Machine-only review policy cannot require Human involvement");
  if (humanReviewer && human === "none")
    throw new SideraError("conflict", "reviewPolicy names a Human reviewer but requires no Human involvement");
  return { reviewers: reviewers as RuleReviewPolicy["reviewers"],
    reviewerSelection: selection as RuleReviewPolicy["reviewerSelection"],
    humanInvolvement: human as RuleReviewPolicy["humanInvolvement"],
    independentRequired: p.independentRequired, allowSelfReview: p.allowSelfReview,
    reviewerCount: count as number, exactObjectHashRequired: true };
}

/**
 * R1 bootstrap governance policy.
 *
 * This is **not** a Basic immutable invariant. It is the versioned, inspectable
 * default review/adoption procedure R1 applies while no adopted parent Rule
 * supplies its own `reviewPolicy`. An adopted Rule at the parent level replaces
 * any field for its children; only parent-boundary narrowing, exact
 * object/digest/version binding, attributable completion and record
 * immutability stay Basic. R1 implements no autonomous Rule evolution.
 */
export const R1_BOOTSTRAP_GOVERNANCE = Object.freeze({
  version: "sidera-r1-bootstrap-governance/1",
  kind: "bootstrap-policy" as const,
  appliesWhen: "no adopted parent Rule supplies reviewPolicy",
  replaceableBy: "adopted World.policy.worldReviewPolicy for World successors; parent policy.reviewPolicy for children",
  autonomousRuleEvolution: false,
  consoleIsNode: false,
  review: Object.freeze({
    World: Object.freeze({ reviewers: "Human", reviewerSelection: "Human", humanInvolvement: "required",
      independentRequired: false, allowSelfReview: true, reviewerCount: 0, exactObjectHashRequired: true } as RuleReviewPolicy),
    Project: Object.freeze({ reviewers: "Human+Machine", reviewerSelection: "AuthorizedOperator", humanInvolvement: "required",
      independentRequired: false, allowSelfReview: true, reviewerCount: 1, exactObjectHashRequired: true } as RuleReviewPolicy),
    Task: Object.freeze({ reviewers: "Machine", reviewerSelection: "ChiefConversation", humanInvolvement: "none",
      independentRequired: false, allowSelfReview: true, reviewerCount: 1, exactObjectHashRequired: true } as RuleReviewPolicy),
  }),
});

/** The bootstrap policy applicable to one level, by name. */
export function bootstrapReviewPolicy(level: "World" | "Project" | "Task"): RuleReviewPolicy {
  return R1_BOOTSTRAP_GOVERNANCE.review[level];
}

/** Applicable policy from an already-adopted parent version's own policy object. */
export function reviewPolicyForRule(level: "World" | "Project" | "Task", policy: Record<string, unknown> | null | undefined): RuleReviewPolicy {
  const declared = policy?.reviewPolicy;
  return declared === undefined ? bootstrapReviewPolicy(level) : normalizeReviewPolicy(declared);
}

/** Compatibility summary published by console.inspect. Reviewer topology here is
 * the bootstrap default, not a Basic invariant. */
export const R1_GOVERNANCE = Object.freeze({
  worldAdoption: "reviewPolicy (bootstrap: Human)",
  projectAdoption: "reviewPolicy (bootstrap: Machine Review + Human)",
  taskAdoption: "reviewPolicy (bootstrap: Chief Conversation Machine Review)",
  bootstrapGovernanceVersion: R1_BOOTSTRAP_GOVERNANCE.version,
  autonomousRuleEvolution: false, consoleIsNode: false,
});
