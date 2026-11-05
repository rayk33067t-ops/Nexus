import { randomUUID } from "crypto";
import { createHash } from "crypto";
export type SourceType = "founder_decision"|"user_interaction"|"agent_observation"|"external_research"|"system_event"|"simulation"|"generated_fiction";
export type Classification = "fact"|"observation"|"hypothesis"|"belief"|"decision"|"memory"|"simulation"|"fictional_canon"|"unresolved_question";
export interface MemoryInput { source_type: SourceType; classification: Classification; content: string; tags?: string[]; reversible?: boolean; expires_at?: number; source_id?: string; previous_id?: string; created_by?: string; }
export function validateFictionLaw(input: MemoryInput): {ok: boolean; reason?: string} {
  if (input.classification === "fictional_canon" && input.source_type !== "generated_fiction") return {ok: false, reason: "fiction must have source_type generated_fiction"};
  if (input.source_type === "generated_fiction" && input.classification !== "fictional_canon" && input.classification !== "simulation") return {ok: false, reason: "generated_fiction must be fictional_canon or simulation"};
  if (input.source_type === "founder_decision" && input.classification !== "decision" && input.classification !== "fact") return {ok: false, reason: "founder_decision must be decision or fact"};
  return {ok: true};
}
export function computeProvenanceHash(content: string, source_type: string, classification: string, created_at: number): string {
  return createHash("sha256").update(`${content}|${source_type}|${classification}|${created_at}`).digest("hex");
}
export function createMemory(db: any, input: MemoryInput) {
  const law = validateFictionLaw(input);
  if (!law.ok) throw new Error(`FICTION_LAW_VIOLATION: ${law.reason}`);
  const id = randomUUID(); const created_at = Math.floor(Date.now()/1000);
  const provenance_hash = computeProvenanceHash(input.content, input.source_type, input.classification, created_at);
  const tags = JSON.stringify(input.tags || []);
  db.prepare(`INSERT INTO memories (id, created_at, source_type, source_id, classification, content, tags, reversible, expires_at, provenance_hash, previous_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, created_at, input.source_type, input.source_id||null, input.classification, input.content, tags, input.reversible!==false?1:0, input.expires_at||null, provenance_hash, input.previous_id||null, input.created_by||"founder");
  return {id, provenance_hash, created_at};
}
