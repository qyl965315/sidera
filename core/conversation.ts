import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.ts";
import { SideraError } from "./types.ts";
import { recordWorld, requireWorld } from "./worlds.ts";
import { reserveCapability } from "./authority.ts";
import { enqueueMessage, getMessage } from "./bus.ts";

export interface ConversationDispatchInput {
  humanId: string; bindingId: string; clientNonce: string; utteranceId: string; body: string;
}

function digest(body: string) { return createHash("sha256").update(body).digest("hex"); }
function binding(db: DatabaseSync, bindingId: string) {
  const row = db.prepare("SELECT * FROM chief_conversations WHERE binding_id=? AND state='active'").get(bindingId) as Record<string, unknown> | undefined;
  if (!row) throw new SideraError("denied", "Exact active Conversation binding is required");
  return { bindingId, chiefNodeId: String(row.chief_node_id), projectRef: String(row.project_ref), conversationRef: String(row.conversation_ref) };
}

/**
 * This table is a private body index over canonical Human utterances and Bus
 * messages. It is deliberately not a second delivery/status authority: send
 * status always comes from messages/effect state, and assistant text exists
 * only after Runtime has accepted an exact correlated Host terminal event.
 */
export function migrateConversation(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_transcript_entries (
      entry_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES chief_conversations(binding_id),
      direction TEXT NOT NULL CHECK(direction IN ('human_to_communicator','communicator_to_human')),
      human_id TEXT REFERENCES human_principals(human_id),
      client_nonce TEXT,
      utterance_id TEXT REFERENCES human_utterances(utterance_id),
      bus_message_id TEXT NOT NULL REFERENCES messages(message_id),
      host_ref TEXT,
      body TEXT NOT NULL,
      body_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(binding_id,human_id,client_nonce),
      UNIQUE(bus_message_id,direction)
    );
    CREATE INDEX IF NOT EXISTS conversation_transcript_binding
      ON conversation_transcript_entries(binding_id,created_at);
  `);
}

export function dispatchConversation(db: DatabaseSync, input: ConversationDispatchInput) {
  if (!input.body.trim() || input.body.length > 12_000) throw new SideraError("conflict", "Conversation body must be 1 to 12000 characters");
  return withTransaction(db, "conversation_dispatch", () => {
    const bound = binding(db, input.bindingId);
    const worldId = recordWorld(db, "nodes", bound.chiefNodeId);
    if (!db.prepare("SELECT 1 FROM world_humans WHERE world_id=? AND human_id=?").get(worldId, input.humanId))
      throw new SideraError("denied", "Human is not in the Conversation World");
    const utterance = db.prepare(`SELECT u.body,u.source_id,s.world_id,s.human_id,s.active,s.presence_ref
      FROM human_utterances u JOIN human_frontend_sources s USING(source_id) WHERE u.utterance_id=?`).get(input.utteranceId) as Record<string, unknown> | undefined;
    if (!utterance || utterance.world_id !== worldId || utterance.human_id !== input.humanId || Number(utterance.active) !== 1 ||
      utterance.body !== input.body || utterance.presence_ref !== "local-human-desktop:conversation")
      throw new SideraError("denied", "Exact same-origin Human Conversation ingress is required");
    const prior = db.prepare(`SELECT * FROM conversation_transcript_entries
      WHERE binding_id=? AND human_id=? AND client_nonce=?`).get(input.bindingId, input.humanId, input.clientNonce) as Record<string, unknown> | undefined;
    if (prior) {
      if (prior.body !== input.body || prior.utterance_id !== input.utteranceId)
        throw new SideraError("conflict", "Client message nonce was already used with different Human input");
      return { fresh: false, messageId: String(prior.bus_message_id), entryId: String(prior.entry_id) };
    }
    const session = db.prepare("SELECT session_id FROM sessions WHERE node_id=? AND state='active'").get(bound.chiefNodeId) as { session_id: string } | undefined;
    if (!session) throw new SideraError("unavailable", "Bound Communicator has no active exact Host session");
    const requestId = `conversation:${input.bindingId}:${input.humanId}:${input.clientNonce}`;
    const permit = reserveCapability(db, { subjectNodeId: bound.chiefNodeId, sessionId: session.session_id,
      capability: "message.send", resource: `node/${bound.chiefNodeId}`, requestId, projectRef: bound.projectRef });
    const message = enqueueMessage(db, { requestId, fromNodeId: bound.chiefNodeId, toNodeId: bound.chiefNodeId,
      targetSessionId: session.session_id, kind: "conversation", body: input.body, reservationId: permit.reservationId });
    const entryId = randomUUID(), now = new Date().toISOString();
    db.prepare("INSERT INTO conversation_transcript_entries VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(entryId, input.bindingId, "human_to_communicator", input.humanId, input.clientNonce, input.utteranceId,
        message.messageId, null, input.body, digest(input.body), now);
    db.prepare("INSERT INTO events VALUES (?,NULL,'conversation.human_admitted',?,?)").run(randomUUID(),
      JSON.stringify({ bindingId: input.bindingId, humanId: input.humanId, utteranceId: input.utteranceId,
        messageId: message.messageId, clientNonce: input.clientNonce, bodyDigest: digest(input.body), form: "Conversation" }), now);
    return { fresh: true, messageId: message.messageId, entryId };
  });
}

/** Called by Runtime only after it has checked exact session and Host correlation. */
export function recordConversationReply(db: DatabaseSync, input: { messageId: string; hostRef: string; body: string }) {
  return withTransaction(db, "conversation_reply", () => {
    const user = db.prepare(`SELECT binding_id FROM conversation_transcript_entries
      WHERE bus_message_id=? AND direction='human_to_communicator'`).get(input.messageId) as { binding_id: string } | undefined;
    if (!user) throw new SideraError("not_found", "Conversation transcript correlation is absent");
    const prior = db.prepare(`SELECT * FROM conversation_transcript_entries
      WHERE bus_message_id=? AND direction='communicator_to_human'`).get(input.messageId) as Record<string, unknown> | undefined;
    if (prior) {
      if (prior.host_ref !== input.hostRef || prior.body !== input.body) throw new SideraError("conflict", "Late Host reply conflicts with the recorded correlated reply");
      return String(prior.entry_id);
    }
    const now = new Date().toISOString(), entryId = randomUUID();
    db.prepare("INSERT INTO conversation_transcript_entries VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(entryId, user.binding_id, "communicator_to_human", null, null, null, input.messageId,
        input.hostRef, input.body, digest(input.body), now);
    db.prepare("INSERT INTO events VALUES (?,NULL,'conversation.host_reply_observed',?,?)").run(randomUUID(),
      JSON.stringify({ bindingId: user.binding_id, messageId: input.messageId, hostRef: input.hostRef,
        bodyDigest: digest(input.body), form: "Conversation", verified: true }), now);
    return entryId;
  });
}

export function conversationView(db: DatabaseSync, input: { humanId: string; bindingId: string }) {
  const bound = binding(db, input.bindingId), worldId = recordWorld(db, "nodes", bound.chiefNodeId);
  if (!db.prepare("SELECT 1 FROM world_humans WHERE world_id=? AND human_id=?").get(worldId, input.humanId))
    throw new SideraError("denied", "Human is not in the Conversation World");
  const entries = db.prepare(`SELECT e.entry_id,e.direction,e.human_id,e.client_nonce,e.bus_message_id,e.host_ref,e.body,e.created_at,
      m.state AS transport_state,m.host_ref AS accepted_host_ref
    FROM conversation_transcript_entries e JOIN messages m ON m.message_id=e.bus_message_id
    WHERE e.binding_id=? ORDER BY e.created_at,e.rowid`).all(input.bindingId);
  return { binding: bound, entries };
}
