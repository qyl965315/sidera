import { createHmac, randomBytes } from "node:crypto";

const OPENAI_SESSION = "openai/session";
const OPENAI_SUBJECT = "openai/subject";
const MAX_OPAQUE_ID_BYTES = 512;

export type OpenAiMetadataState = "absent" | "usable" | "rejected";

/**
 * A boundary-local diagnostic only. It is intentionally not a Core identity,
 * Grant, HumanSemanticAct, or Effect input.
 */
export interface OpenAiSessionCorrelationDiagnostic {
  metadataState: OpenAiMetadataState;
  correlationObserved: boolean;
  sessionFingerprint?: string;
  subjectFingerprint?: string;
  authority: "NOT_A_GRANT";
  humanAct: false;
  effect: false;
  claimUsable: false;
}

export interface GptSessionCorrelation {
  observe(meta: Record<string, unknown> | undefined): OpenAiSessionCorrelationDiagnostic;
}

function validOpaqueId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (Buffer.byteLength(value, "utf8") > MAX_OPAQUE_ID_BYTES) return false;
  // Refuse controls so an untrusted value cannot escape a structured diagnostic.
  return !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Converts optional, client-provided OpenAI metadata into a process-local
 * diagnostic key. HMAC means neither identifiers nor a reusable unsalted hash
 * leave this boundary. The caller must already have passed boundary auth.
 */
export function createGptSessionCorrelation(secret = randomBytes(32)): GptSessionCorrelation {
  const fingerprint = (value: string) =>
    `hmac-sha256:${createHmac("sha256", secret).update(value).digest("hex").slice(0, 24)}`;

  return {
    observe(meta) {
      const hasSession = meta !== undefined && Object.hasOwn(meta, OPENAI_SESSION);
      const hasSubject = meta !== undefined && Object.hasOwn(meta, OPENAI_SUBJECT);
      if (!hasSession && !hasSubject) {
        return {
          metadataState: "absent", correlationObserved: false,
          authority: "NOT_A_GRANT", humanAct: false, effect: false, claimUsable: false,
        };
      }

      const session = meta?.[OPENAI_SESSION];
      const subject = meta?.[OPENAI_SUBJECT];
      // A subject alone cannot select a conversation, and malformed optional
      // metadata invalidates correlation rather than receiving best-effort use.
      if (!validOpaqueId(session) || (hasSubject && !validOpaqueId(subject))) {
        return {
          metadataState: "rejected", correlationObserved: false,
          authority: "NOT_A_GRANT", humanAct: false, effect: false, claimUsable: false,
        };
      }

      return {
        metadataState: "usable", correlationObserved: true,
        sessionFingerprint: fingerprint(session),
        ...(validOpaqueId(subject) ? { subjectFingerprint: fingerprint(subject) } : {}),
        authority: "NOT_A_GRANT", humanAct: false, effect: false, claimUsable: false,
      };
    },
  };
}
