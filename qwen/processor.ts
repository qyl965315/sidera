/** Shared Pool is a world archive. Subjective state is never an archive kind. */
export type ArchiveKind = "history" | "evidence" | "artifact" | "decision";
export interface ArchiveEntry { kind: ArchiveKind; ref: string; text: string }
export interface ArchiveHit { kind: ArchiveKind; ref: string; excerpt: string }
/** Optional infrastructure: derived indexes, retrieval and accessible rendering.
 * No dispatch-text rewriting, judgments, decisions or writes to Node subjectivity.
 */
export interface ArchiveAssist {
  index(entry: Readonly<ArchiveEntry>): Promise<void>;
  retrieve(query: string, allowedRefs: readonly string[]): Promise<ArchiveHit[]>;
  accessible(entry: Readonly<ArchiveEntry>): Promise<string>;
}
export const disabledArchiveAssist: ArchiveAssist = {
  async index() {}, async retrieve() { return []; }, async accessible(entry) { return entry.text; },
};

/** Core supplies authorized refs; an index can never widen that visible world archive. */
export async function retrieveArchive(assist: ArchiveAssist, query: string,
  allowedRefs: readonly string[]): Promise<ArchiveHit[]> {
  const permitted = new Set(allowedRefs);
  if (!permitted.size) return [];
  return (await assist.retrieve(query, allowedRefs)).filter(hit => permitted.has(hit.ref));
}
